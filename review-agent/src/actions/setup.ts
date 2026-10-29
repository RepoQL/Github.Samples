/**
 * The setup action: resolve the pull request, check out its head with full history, install rql, and serve the
 * checkout until semantic search is ready. Its post step stops the host and keeps the index.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { githubFromEnvironment, read } from "../github-client.js";
import { accountLine, eventPayload, hostStatus, repository, run, servingPid, sleep } from "./common.js";

const INDEX = ".repoql/cache";

interface PullRequest {
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

async function git(args: string[], cwd: string, secret?: string): Promise<string> {
  const ran = await run("git", args, { cwd });
  if (ran.code !== 0) {
    const text = secret ? (ran.stdout + ran.stderr).split(secret).join("***") : ran.stdout + ran.stderr;
    throw new Error(`git ${args.filter((arg) => !arg.includes("extraheader")).join(" ")} failed: ${text.trim()}`);
  }
  return ran.stdout;
}

/**
 * Check out sha with every branch and the whole history: the reviewer diffs against the base, and RepoQL's history
 * senses read it. Ignored files are cleaned, except the RepoQL index a self-hosted runner keeps between reviews.
 */
async function checkout(workspace: string, server: string, repo: string, sha: string, token: string): Promise<void> {
  mkdirSync(workspace, { recursive: true });
  if (!existsSync(join(workspace, ".git"))) {
    await git(["init", "--quiet"], workspace);
    await git(["remote", "add", "origin", `${server}/${repo}`], workspace);
  } else {
    await git(["remote", "set-url", "origin", `${server}/${repo}`], workspace);
  }
  // As actions/checkout does: the reviewer reads branches and history with git, so the credential stays for the
  // job, and the post step takes it away.
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  core.setSecret(header);
  await git(["config", "--local", `http.${server}/.extraheader`, header], workspace, header);
  await git(["fetch", "--quiet", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], workspace, header);
  await git(["fetch", "--quiet", "--no-tags", "origin", sha], workspace, header);
  await git(["checkout", "--quiet", "--force", "--detach", sha], workspace);
  await git(["reset", "--quiet", "--hard", sha], workspace);
  await git(["clean", "-ffdxq", "-e", INDEX], workspace);
}

async function installRql(version: string): Promise<string> {
  const found = await run("sh", ["-c", "command -v rql"]);
  if (found.code === 0 && found.stdout.trim()) return found.stdout.trim();
  const response = await fetch("https://downloads.repoql.ai/latest/install-rql.sh");
  if (!response.ok) throw new Error(`The rql installer could not be downloaded: ${response.status}`);
  const env = { ...process.env };
  if (version) env.REPOQL_INSTALL_VERSION = version;
  else delete env.REPOQL_INSTALL_VERSION;
  const installed = await run("bash", ["-s"], { input: await response.text(), env });
  process.stdout.write(installed.stdout + installed.stderr);
  if (installed.code !== 0) throw new Error("The rql installer failed. Its output is above.");
  const bin = join(homedir(), ".local", "bin");
  core.addPath(bin);
  return join(bin, "rql");
}

/** A host the step launched: its pid, and the `rql watch` that launched it under an observer when there is one. */
interface Launched {
  pid: number;
  watchPid?: number;
  exited: () => boolean;
  log: string;
}

function launch(command: string, args: string[], cwd: string, log: string, env: NodeJS.ProcessEnv): { child: ReturnType<typeof spawn>; exited: () => boolean } {
  // Not this step's process: the host must outlive it, and the post step stops it.
  writeFileSync(log, "");
  const out = openSync(log, "a");
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  child.unref();
  let done = false;
  child.on("exit", () => (done = true));
  child.on("error", () => (done = true));
  return { child, exited: () => done };
}

/** The pid `rql watch` reports for the process it started: `[rql watch] pid: N`. */
export function watchedPid(log: string): number {
  return Number(/^\[rql watch\] pid: (\d+)/m.exec(log)?.[1] ?? "0");
}

/**
 * Start an observer host on a workspace of its own, then launch the checkout's host under `rql watch` from there, so
 * the checkout's host exports every span, metric and log line into the observer. A host cannot collect its own
 * telemetry: its collector accepts only a registered run, and a run can only be registered once the host is up.
 */
async function launchObserved(rql: string, observerRql: string, workspace: string, temp: string, env: NodeJS.ProcessEnv): Promise<Launched> {
  const observer = join(temp, "observer");
  mkdirSync(observer, { recursive: true });
  await run(observerRql, ["init", "--path", observer]);
  const observerLog = join(temp, "rql-observer.log");
  // Started explicitly: `rql watch` refuses with "No host is running" rather than launching one, and an explicit
  // serve never idles out under a quiet review.
  const host = launch(observerRql, ["serve", "--path", observer], observer, observerLog, env);
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    ready = (await run(observerRql, ["host", "status"], { cwd: observer })).code === 0;
    if (!ready) {
      if (host.exited()) break;
      await sleep(2000);
    }
  }
  if (!ready) {
    core.info(readFileSync(observerLog, "utf8"));
    throw new Error("The observer host did not start. Its log is above.");
  }
  core.saveState("observer", observer);
  core.saveState("observer-rql", observerRql);
  core.exportVariable("REVIEW_OBSERVER", observer);
  core.exportVariable("REVIEW_OBSERVER_RQL", observerRql);
  const log = join(temp, "rql-host.log");
  const watched = launch(observerRql, ["watch", "--cwd", workspace, "--", rql, "serve", "--path", workspace], observer, log, env);
  let pid = 0;
  for (let attempt = 0; attempt < 30 && !pid; attempt++) {
    pid = watchedPid(readFileSync(log, "utf8"));
    if (!pid) {
      if (watched.exited()) break;
      await sleep(1000);
    }
  }
  if (!pid) {
    core.info(readFileSync(log, "utf8"));
    throw new Error("rql watch exited before it reported the host it started. Its log is above.");
  }
  return { pid, watchPid: watched.child.pid ?? 0, exited: watched.exited, log };
}

function launchPlain(rql: string, workspace: string, temp: string, env: NodeJS.ProcessEnv): Launched {
  const log = join(temp, "rql-host.log");
  const host = launch(rql, ["serve", "--path", workspace], workspace, log, env);
  return { pid: host.child.pid ?? 0, exited: host.exited, log };
}

async function serve(launched: Launched, rql: string, workspace: string, timeoutMinutes: number): Promise<void> {
  const { pid } = launched;
  core.saveState("host-pid", String(pid));
  if (launched.watchPid) core.saveState("watch-pid", String(launched.watchPid));
  core.exportVariable("REVIEW_HOST_PID", String(pid));

  // The host this step launches is the only one it accepts, told by its pid: any host answers a status call for the
  // workspace, and on a self-hosted runner one left by an earlier job may still be up.
  let status = "";
  for (let attempt = 0; attempt < 90; attempt++) {
    status = await hostStatus(rql, workspace);
    if (servingPid(status) === String(pid)) break;
    if (launched.exited()) {
      core.info(readFileSync(launched.log, "utf8"));
      throw new Error("The host exited before it answered for the checkout. Its log is above.");
    }
    await sleep(2000);
  }
  if (servingPid(status) !== String(pid)) {
    core.info(status);
    throw new Error(`The host serving the checkout is not the one this step launched (pid ${pid}). Stop the other host on the runner, then run the review again.`);
  }
  const account = accountLine(status);
  if (!account || /^Account: (not authenticated|unavailable|not reported)/.test(account)) {
    core.info(status);
    throw new Error(
      `rql is not signed in (${account || "no Account line"}), so it has no semantic search. Either connect this repository to RepoQL with the GitHub App and give the job 'permissions: id-token: write', or set REPOQL_API_KEY from a secret.`,
    );
  }
  core.info(`Signed in: ${account}`);
  // Semantic search is the bar a reviewer needs; the rest of the index can finish while it reviews.
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (!/searchable=true/.test(status)) {
    if (Date.now() >= deadline) {
      core.info(status);
      throw new Error(`Semantic search was not ready after ${timeoutMinutes} minutes. Raise ready-timeout-minutes, or keep cache-index on so the next run starts warm.`);
    }
    await sleep(10_000);
    status = await hostStatus(rql, workspace);
  }
  core.info(status);
  if (servingPid(status) !== String(pid)) {
    throw new Error(`The host serving the checkout changed while the index warmed: the step launched pid ${pid}, and pid ${servingPid(status) || "none"} answers now.`);
  }
}

/** A checkout the workflow made itself must be the head under review, with the base branch to diff against. */
async function verifyCheckout(workspace: string, head: string): Promise<void> {
  if (!existsSync(join(workspace, ".git"))) {
    throw new Error(`There is no git checkout at ${workspace}. Check the pull request out there first, or leave checkout on.`);
  }
  const actual = (await run("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  if (actual !== head) throw new Error(`The checkout at ${workspace} is at ${actual || "no commit"}, not the pull request's head ${head}.`);
  const shallow = (await run("git", ["rev-parse", "--is-shallow-repository"], { cwd: workspace })).stdout.trim();
  if (shallow === "true") throw new Error(`The checkout at ${workspace} is shallow. Check it out with fetch-depth: 0: the reviewer diffs against the base and reads history.`);
}

export async function setup(environ: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = core.getInput("token");
  const prInput = core.getInput("pr");
  const command = core.getInput("command") || "/review";
  const cacheIndex = core.getInput("cache-index") !== "false";
  const ownCheckout = core.getInput("checkout") !== "false";
  const root = environ.GITHUB_WORKSPACE ?? process.cwd();
  const workspace = resolve(root, core.getInput("path") || ".");
  const temp = join(environ.RUNNER_TEMP ?? "/tmp", "review");
  const { full: repo } = repository(environ);
  mkdirSync(temp, { recursive: true });

  if (!prInput) throw new Error("No pull request to review. Pass the setup action a pr input, or run it on a pull_request or issue_comment event.");
  const pr = Number(prInput);
  const github = githubFromEnvironment(environ, token);
  const pull = (await read(github, `repos/${repo}/pulls/${pr}`)) as PullRequest;
  // The reviewer runs the change's code with this job's credentials, so a fork's code never runs here, whatever
  // started the run.
  const headRepo = pull.head.repo?.full_name ?? "(a deleted fork)";
  if (headRepo !== repo) throw new Error(`Pull request #${pr} comes from ${headRepo}; the reviewer only reviews branches of ${repo}.`);
  writeFileSync(join(temp, "pr.json"), JSON.stringify(pull));

  // A second opinion: the fresh input, or `<command> fresh` as the comment that started the run.
  let fresh = core.getInput("fresh") === "true";
  const comment: string = environ.GITHUB_EVENT_NAME === "issue_comment" ? (eventPayload(environ).comment?.body ?? "") : "";
  if (new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+fresh`).test(comment)) fresh = true;

  const head = pull.head.sha;
  const base = pull.base.ref;
  core.setOutput("pr", String(pr));
  core.setOutput("head-sha", head);
  core.setOutput("base-ref", base);
  // Read by the review action, so a workflow wires nothing between the two.
  for (const [name, value] of Object.entries({
    REVIEW_PR: String(pr), REVIEW_HEAD_SHA: head, REVIEW_BASE_REF: base, REVIEW_FRESH: String(fresh), REVIEW_COMMAND: command,
    REVIEW_WORKSPACE: workspace,
  })) core.exportVariable(name, value);

  if (ownCheckout) {
    const server = environ.GITHUB_SERVER_URL ?? "https://github.com";
    await core.group("Check out the pull request", () => checkout(workspace, server, repo, head, token));
    core.saveState("checked-out", "true");
  } else {
    await verifyCheckout(workspace, head);
  }
  await git(["rev-parse", "--verify", "--quiet", `origin/${base}`], workspace);
  core.saveState("workspace", workspace);

  const index = join(workspace, INDEX);
  const key = `repoql-index-${environ.RUNNER_OS}-${environ.GITHUB_RUN_ID}-${environ.GITHUB_RUN_ATTEMPT || "1"}`;
  core.saveState("index-key", cacheIndex ? key : "");
  if (cacheIndex) {
    await core.group("Restore the RepoQL index", async () => {
      try {
        const restored = await cache.restoreCache([index], key, [`repoql-index-${environ.RUNNER_OS}-`]);
        core.info(restored ? `Restored the index from ${restored}.` : "No cached index; the review indexes cold.");
      } catch (error) {
        core.warning(`The RepoQL index could not be restored: ${String(error)}`);
      }
    });
  }

  // A binary the workflow built or chose is served as it is. The released rql is installed when none is given, and
  // as the observer, which is a host of its own.
  const given = core.getInput("rql");
  const observe = core.getInput("observe") === "true";
  const installed = !given || observe ? await core.group("Install rql", () => installRql(core.getInput("rql-version"))) : "";
  const rql = given ? resolve(root, given) : installed;
  if (!existsSync(rql)) throw new Error(`The rql input names ${rql}, which does not exist.`);
  const version = (await run(rql, ["--version"])).stdout.trim();
  if (!version) throw new Error(`${rql} --version printed nothing; it is not an rql that can serve the review.`);
  core.info(version);
  core.setOutput("rql", rql);
  core.exportVariable("REVIEW_RQL", rql);
  core.exportVariable("REVIEW_RQL_VERSION", core.getInput("rql-label") || version);
  core.saveState("rql", rql);

  const timeout = Number(core.getInput("ready-timeout-minutes") || "30");
  // The host clones the repositories the reviewer imports, and reads its credential from its own environment.
  const env = { ...process.env, GH_TOKEN: token };
  await core.group("Serve the checkout", async () => {
    const launched = observe
      ? await launchObserved(rql, installed, workspace, temp, env)
      : launchPlain(rql, workspace, temp, env);
    await serve(launched, rql, workspace, timeout);
  });
}

async function stopped(pid: number, seconds: number): Promise<boolean> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return true;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < seconds; waited++) {
    if (!alive()) return true;
    await sleep(1000);
  }
  return !alive();
}

/**
 * Stop the host gracefully, so the index on disk is whole, then keep it; stop the observer; take the checkout's
 * credential away. Only what this action started or set is touched.
 */
export async function setupPost(): Promise<void> {
  const workspace = core.getState("workspace");
  const pid = Number(core.getState("host-pid") || "0");
  // SIGTERM to `rql watch` shuts the host it started down gracefully, which lets it flush the embedding cache.
  const watchPid = Number(core.getState("watch-pid") || "0");
  const key = core.getState("index-key");
  let whole = true;
  if (watchPid > 0) await stopped(watchPid, 45);
  if (pid > 0 && !(await stopped(pid, 60))) {
    core.warning("The rql host did not stop within a minute; its index is not cached.");
    whole = false;
  }
  const observer = core.getState("observer");
  if (observer) await run(core.getState("observer-rql") || "rql", ["host", "stop"], { cwd: observer });
  const index = workspace ? join(workspace, INDEX) : "";
  if (whole && key && index && existsSync(index)) {
    try {
      await cache.saveCache([index], key);
      core.info(`Kept the RepoQL index as ${key}.`);
    } catch (error) {
      core.warning(`The RepoQL index could not be cached: ${String(error)}`);
    }
  }
  if (core.getState("checked-out") === "true" && workspace && existsSync(join(workspace, ".git"))) {
    const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
    await run("git", ["config", "--local", "--unset-all", `http.${server}/.extraheader`], { cwd: workspace });
  }
}
