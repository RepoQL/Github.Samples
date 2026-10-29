/**
 * The review action: one review turn with the chosen agent under the review kata, on the checkout the setup action
 * serves. Requires that the reviewer used RepoQL, renders its record into a plan, scrubs credentials, and uploads the
 * plan for the publish action. Writes nothing to the pull request.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";

import { type GitHub, githubFromEnvironment } from "../github-client.js";
import type { Adapter } from "../harness/adapter.js";
import { createClaudeAdapter } from "../harness/claude.js";
import { createCodexAdapter } from "../harness/codex.js";
import { createExternalAdapter } from "../harness/external.js";
import { createOpencodeAdapter } from "../harness/opencode.js";
import * as job from "../job.js";
import { brief, gather } from "../pull-request.js";
import { markdown, render } from "../render.js";
import { adapterName, hostStatus, repository, run, runUrl, servingPid, sleep } from "./common.js";

/** The pack's own directory, which holds record.schema.json: the bundle runs from dist/, the sources from src/. */
export const PACK = (() => {
  let directory = import.meta.dirname;
  while (!existsSync(join(directory, "record.schema.json")) && dirname(directory) !== directory) directory = dirname(directory);
  return directory;
})();

/** The adapter for an agent input, running its harness in the checkout under review. */
export function adapterFor(agent: string, workspace: string): Adapter {
  if (agent === "claude") return createClaudeAdapter({ cwd: workspace });
  if (agent === "codex") return createCodexAdapter({ cwd: workspace });
  if (agent === "opencode") return createOpencodeAdapter({ cwd: workspace });
  const path = resolve(workspace, agent);
  if (!existsSync(path)) throw new Error(`The agent input is '${agent}'. Use claude, codex, opencode, or the path of an adapter script in the checkout.`);
  return createExternalAdapter(path, { cwd: workspace });
}

interface Artifact {
  id: number;
  expired: boolean;
  created_at: string;
  workflow_run?: { id?: number };
}

/**
 * Restore the session from the newest artifact of this pull request, whatever started the run that saved it: an
 * artifact, unlike the Actions cache, is not scoped to the ref a run started on, so a push, a comment and a reply all
 * continue one session.
 */
async function restoreSession(github: GitHub, token: string, name: string, directories: string[], temp: string): Promise<void> {
  const repo = repository();
  const listed = (await github.paginate(`repos/${repo.full}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`, "artifacts")) as Artifact[];
  const newest = listed.filter((artifact) => !artifact.expired).sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  const runId = newest?.workflow_run?.id;
  if (!newest || !runId) {
    core.info("No earlier session for this pull request; the reviewer starts a new one.");
    return;
  }
  const into = join(temp, "session-restore");
  rmSync(into, { recursive: true, force: true });
  await new DefaultArtifactClient().downloadArtifact(newest.id, {
    path: into,
    findBy: { token, workflowRunId: runId, repositoryOwner: repo.owner, repositoryName: repo.name },
  });
  core.info(`Restored ${job.unpackState(join(into, "session.json.gz"), directories)} session file(s) from artifact ${newest.id}.`);
}

/**
 * The tool requests the observed host served, from the observer's telemetry. Spans leave the host in batches, so the
 * last ones are given a moment.
 */
/**
 * The served-request count from `rql query --jsonl`. The rendered form ends with a footer line, so reading the
 * table's last line would read the footer.
 */
export function servedCount(output: string): number {
  for (const line of output.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      const served = row && typeof row === "object" ? (row as { served?: unknown }).served : undefined;
      if (typeof served === "number" && Number.isInteger(served)) return served;
    } catch {
      continue;
    }
  }
  return 0;
}

async function servedRequests(observer: string, rql: string): Promise<number> {
  const sql =
    "SELECT coalesce(sum(count), 0)::BIGINT AS served FROM watch.span_stats() WHERE kind = 'server' AND " +
    "(name LIKE 'POST /repoql.tools.v1.%' OR name LIKE 'POST /repoql.management.v1.CommandService/%')";
  for (let attempt = 0; attempt < 6; attempt++) {
    const served = servedCount((await run(rql, ["query", sql, "--jsonl"], { cwd: observer })).stdout);
    if (served > 0) return served;
    await sleep(5000);
  }
  return 0;
}

/** Upload, replacing an artifact of the same name made by an earlier attempt of this run. */
async function upload(name: string, files: string[], root: string, retentionDays: number): Promise<void> {
  const client = new DefaultArtifactClient();
  try {
    await client.deleteArtifact(name);
  } catch {
    // Nothing of that name in this run yet.
  }
  await client.uploadArtifact(name, files, root, { retentionDays });
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile());
}

export async function review(environ: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pr = environ.REVIEW_PR;
  const rql = environ.REVIEW_RQL;
  if (!pr || !rql) {
    throw new Error("Run the RepoQL review setup action earlier in this job: the review action needs the pull request it resolved and the rql it serves.");
  }
  const token = core.getInput("token");
  const agent = core.getInput("agent") || "claude";
  const store = core.getInput("session-store") || "artifact";
  const extra = core.getInput("redact");
  // The checkout the setup action served, which need not be the workspace's root.
  const workspace = environ.REVIEW_WORKSPACE || environ.GITHUB_WORKSPACE || process.cwd();
  const temp = environ.RUNNER_TEMP ?? "/tmp";
  const folder = join(temp, "review");
  const { full: repo } = repository(environ);
  const name = adapterName(agent);
  const artifact = `review-${pr}-${environ.GITHUB_RUN_ATTEMPT || "1"}`;
  mkdirSync(folder, { recursive: true });
  core.setOutput("pr", pr);
  core.setOutput("head-sha", environ.REVIEW_HEAD_SHA ?? "");
  core.setOutput("artifact", artifact);
  for (const secret of extra.split(/\r?\n/).map((line) => line.trim())) if (secret) core.setSecret(secret);

  const kata = realpathSync(core.getInput("kata") ? resolve(workspace, core.getInput("kata")) : join(PACK, "kata"));
  const templates = core.getInput("prompts") ? resolve(workspace, core.getInput("prompts")) : join(PACK, "prompts");
  for (const file of [join(kata, "SKILL.md"), join(kata, "record.md"), ...["first.md", "again.md", "environment.md"].map((f) => join(templates, f))]) {
    if (!existsSync(file)) throw new Error(`${file} is missing.`);
  }

  const adapter = adapterFor(agent, workspace);
  const directories = await adapter.stateDirs();
  const github = githubFromEnvironment(environ, token);
  // The reviewer uses gh itself, read-only, with this token.
  process.env.GH_TOKEN = token;
  let rendered = false;

  try {
    if ((await adapter.prepare()) !== 0) throw new Error(`The ${name} agent could not be prepared; the reason is above.`);

    if (store === "artifact") {
      await core.group("Restore the reviewer's session", async () => {
        try {
          await restoreSession(github, token, `review-session-${name}-${pr}`, directories, temp);
        } catch (error) {
          core.warning(`The earlier session could not be restored; the reviewer starts a new one. ${String(error)}`);
        }
      });
    }

    // The description, every thread with its replies, and the earlier reviews: what the reviewer reads first, and
    // what the renderer needs to place each finding.
    const context = await gather(github, repo, Number(pr));
    writeFileSync(join(folder, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
    writeFileSync(join(folder, "pull-request.md"), brief(context));

    const pull = JSON.parse(readFileSync(join(folder, "pr.json"), "utf8")) as { title?: string };
    mkdirSync(join(temp, "scratch"), { recursive: true });
    job.prompts(templates, folder, {
      pr, repo, title: pull.title ?? "", base_ref: environ.REVIEW_BASE_REF ?? "", head_sha: environ.REVIEW_HEAD_SHA ?? "",
      kata, brief: join(folder, "pull-request.md"), scratch: join(temp, "scratch"), instructions: core.getInput("instructions"),
    });

    const model = core.getInput("model");
    const agentArgs = core.getInput("agent-args").split(/\r?\n/).filter((line) => line.trim());
    const code = await adapter.run({
      repo, pr: Number(pr), head: environ.REVIEW_HEAD_SHA ?? "",
      first: join(folder, "first.md"), again: join(folder, "again.md"), schema: join(PACK, "record.schema.json"),
      record: join(folder, "record.json"), events: join(folder, "events.jsonl"), sight: join(folder, "session.json"),
      // `none` keeps no session, so one left on a persistent runner is not continued either.
      fresh: environ.REVIEW_FRESH === "true" || store === "none",
      ...(model ? { model } : {}), rql, agentArgs,
    });
    if (code !== 0) throw new Error(`The ${name} agent exited ${code}.`);

    const strict = (core.getInput("require-repoql") || "fail") !== "warn";
    const impaired = core.getInput("impaired").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const gated = job.gate(join(folder, "session.json"));
    if (!gated.ok) {
      const unused = "The reviewer finished without a successful repoql tool call: the MCP server failed to start, or the reviewer ignored it. The events file in the review artifact shows which.";
      if (strict) throw new Error(unused);
      core.warning(unused);
      impaired.push(job.NO_REPOQL);
    }
    if (gated.impaired) {
      core.warning("The re-review made no successful repoql tool call; the review will say so.");
      impaired.push(gated.impaired);
    }
    // With an observer, the calls count only when this job's host answered them: the host's own telemetry must
    // hold the tool requests the reviewer made.
    if (environ.REVIEW_OBSERVER && job.repoqlCalls(join(folder, "session.json")) > 0) {
      const served = await servedRequests(environ.REVIEW_OBSERVER, environ.REVIEW_OBSERVER_RQL || "rql");
      core.info(`tool requests the reviewed host served: ${served}`);
      if (served === 0) {
        const other = `The reviewer made repoql calls and the host the setup action launched (pid ${environ.REVIEW_HOST_PID}) served none of them: another host answered the reviewer.`;
        if (strict) throw new Error(other);
        core.warning(other);
        impaired.push("The reviewer's RepoQL calls were answered by a host other than the one serving this checkout.");
      }
    }
    // The reviewer's rql finds its host by the directory it runs in, so a host that replaced this job's gives a review
    // of another tree with every call still successful.
    const status = await hostStatus(rql, workspace);
    if (servingPid(status) !== environ.REVIEW_HOST_PID) {
      core.info(status);
      throw new Error(`The host serving the checkout is no longer the one the setup action launched (pid ${environ.REVIEW_HOST_PID}): pid ${servingPid(status) || "none"} answers now. The review may have read another host's index.`);
    }

    const sight = job.sight(join(folder, "session.json"), environ.REVIEW_RQL_VERSION ?? "unknown", model || agent,
      runUrl(environ), environ.REVIEW_COMMAND || "/review", impaired);
    writeFileSync(join(folder, "sight.json"), `${JSON.stringify(sight)}\n`);
    const raw = existsSync(join(folder, "record.json")) ? readFileSync(join(folder, "record.json"), "utf8") : "";
    let record: unknown = null;
    try {
      record = JSON.parse(raw);
    } catch {
      record = null;
    }
    const plan = render(record, context, sight, raw);
    writeFileSync(join(folder, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    core.setOutput("verdict", plan.verdict);
    rendered = true;
  } finally {
    // Everything that leaves the runner is scrubbed first: log masking covers the job log, not uploaded files, and
    // the reviewer held credentials while it wrote its proof.
    const secrets = job.secretsOf({ ...environ, GH_TOKEN: token }, extra);
    if (store === "artifact" && directories.length) {
      try {
        const packed = join(temp, "session-out", "session.json.gz");
        const hits = job.packState(packed, directories, secrets);
        if (hits) core.warning(`Redacted ${hits} credential occurrence(s) from the reviewer's session.`);
        await upload(`review-session-${name}-${pr}`, [packed], join(temp, "session-out"), Number(core.getInput("session-retention-days") || "30"));
      } catch (error) {
        core.warning(`The reviewer's session could not be kept; the next review starts a new one. ${String(error)}`);
      }
    }
    // A scrubbed copy is what is uploaded: the host logs in this folder are still being written, by hosts the setup
    // action stops after the job's last step.
    const scrubbed = join(temp, "review-upload");
    rmSync(scrubbed, { recursive: true, force: true });
    const hits = job.snapshot([folder], scrubbed, secrets);
    if (hits) core.warning(`Redacted ${hits} credential occurrence(s) from the review's files.`);
    // The plan the publish job posts, and the summary below, are the scrubbed ones too.
    job.redact([join(folder, "plan.json"), join(folder, "record.json")], secrets);
    try {
      await upload(artifact, listFiles(join(scrubbed, "review")), join(scrubbed, "review"), 14);
    } catch (error) {
      core.warning(`The review could not be uploaded: ${String(error)}`);
    }
    // After redaction: the summary is public to everyone who can read the run.
    if (rendered) {
      const plan = JSON.parse(readFileSync(join(folder, "plan.json"), "utf8"));
      await core.summary.addRaw(markdown(plan)).write();
    }
  }
}
