/**
 * Run and archive persistent Codex review sessions across pull request pushes.
 *
 * One of the harness adapters: the only file that knows Codex. Every adapter takes the same `run`, `archive` and
 * `state-dirs` commands, writes the record the harness returned, and writes the sight file the gate and the renderer
 * read.
 */

import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Adapter,
  type AdapterDeps,
  type RunArgs,
  type Runtime,
  type SessionRecord,
  errorText,
  exited,
  feedPrompt,
  forEachLine,
  isObject,
  isOsError,
  isValueError,
  jsonDumps,
  readSession,
  runCommand,
  running,
  runtime,
  sessionRecordPath,
  started,
  unlinkMissingOk,
  waitExit,
  writeJson,
} from "./adapter.js";

export function codexHome(environ: NodeJS.ProcessEnv): string {
  return environ.CODEX_HOME || join(homedir(), ".codex");
}

export function sessionPath(repo: string, number: number, environ: NodeJS.ProcessEnv): string {
  return sessionRecordPath(codexHome(environ), repo, number);
}

/** The directories a runner must keep between reviews for a session to continue. */
export function stateDirs(environ: NodeJS.ProcessEnv): string[] {
  const home = codexHome(environ);
  return [join(home, "sessions"), join(home, "review-sessions")];
}

/** A completed, successful call to the repoql MCP server: a failed call followed by plain reads is no use of it. */
export function isRepoqlCall(event: Record<string, unknown>): boolean {
  const item = event.item;
  if (event.type !== "item.completed" || !isObject(item)) return false;
  const result = item.result;
  return (
    item.type === "mcp_tool_call" &&
    item.server === "repoql" &&
    item.status === "completed" &&
    (item.error === undefined || item.error === null) &&
    !(isObject(result) && result.isError)
  );
}

async function stop(child: ChildProcess, rt: Runtime, deadline?: number): Promise<void> {
  const grace = rt.timeouts.stop;
  const remaining = () => (deadline === undefined ? grace : Math.max(0, Math.min(grace, deadline - performance.now())));
  try {
    if (running(child)) {
      child.kill("SIGTERM");
      if (!(await waitExit(child, remaining()))) {
        child.kill("SIGKILL");
        if (!(await waitExit(child, remaining()))) {
          throw new Error(`Command '${child.spawnargs.join(" ")}' timed out after ${grace / 1000} seconds`);
        }
      }
    }
  } catch (error) {
    if (!isOsError(error)) throw error;
  } finally {
    for (const stream of [child.stdin, child.stdout]) stream?.destroy();
  }
}

/** Return the `-c key=value` pairs of the arguments, the only ones every codex command takes. */
export function configOverrides(codexArgs: string[]): string[] {
  const overrides: string[] = [];
  for (let i = 0; i + 1 < codexArgs.length; i++) {
    const flag = codexArgs[i] as string;
    if (flag === "-c" || flag === "--config") overrides.push(flag, codexArgs[i + 1] as string);
  }
  return overrides;
}

class Messages {
  private readonly items: unknown[] = [];
  private wake: (() => void) | undefined;

  put(item: unknown): void {
    this.items.push(item);
    this.wake?.();
  }

  /** The next message, or nothing when none arrived within `ms`. */
  async get(ms: number): Promise<{ item: unknown } | undefined> {
    if (!this.items.length) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    return this.items.length ? { item: this.items.shift() } : undefined;
  }
}

class EOFError extends Error {}
class TimeoutError extends Error {}

/** Return lost only when the server explicitly refuses thread/resume. */
export async function compact(sessionId: string, rt: Runtime, overrides: string[] = []): Promise<"lost" | "compacted" | "skipped"> {
  let server: ChildProcess | undefined;
  const deadline = performance.now() + rt.timeouts.compact;
  try {
    // The overrides carry this job's rql: without them the app-server
    // starts the MCP servers of CODEX_HOME's config, the rql on PATH.
    const child = rt.spawn("codex", ["app-server", ...overrides], { cwd: rt.cwd(), stdio: ["pipe", "pipe", "inherit"] });
    await started(child);
    server = child;
    const messages = new Messages();
    let reading = true;
    const end = (error?: unknown) => {
      if (!reading) return;
      reading = false;
      if (error !== undefined) messages.put(error);
      messages.put(new EOFError("Codex app-server closed its output"));
    };
    forEachLine(child.stdout!, (line) => {
      if (!reading) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        return end(error);
      }
      messages.put(message);
    }).then(() => end(), end);
    child.stdin!.on("error", (error) => messages.put(error));

    const send = (message: unknown) => {
      child.stdin!.write(jsonDumps(message) + "\n");
    };

    let completed = false;
    let compactRequested = false;

    const receive = async (responseId?: number): Promise<Record<string, unknown>> => {
      for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new TimeoutError("Codex compaction exceeded its time limit");
        const next = await messages.get(remaining);
        if (next === undefined) throw new TimeoutError("Codex compaction exceeded its time limit");
        const message = next.item;
        if (message instanceof Error) throw message;
        if (!isObject(message)) throw new Error("Codex app-server returned a non-object message");
        if (compactRequested && (message.method === "turn/completed" || message.method === "thread/compacted")) {
          completed = true;
          if (responseId === undefined) return message;
        }
        if (responseId !== undefined && message.id === responseId) return message;
      }
    };

    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-review", title: "codex review", version: "1" } } });
    let response = await receive(1);
    if ("error" in response) throw new Error(jsonDumps(response.error));
    send({ method: "initialized" });
    // With the directory this job runs in. A thread resumed without one
    // keeps the directory it was created in, and starts its MCP servers
    // there: another runner's checkout, when that runner made the session.
    // `codex exec resume` needs no such pin; it takes the directory it runs in.
    send({ id: 2, method: "thread/resume", params: { threadId: sessionId, cwd: rt.cwd() } });
    response = await receive(2);
    if ("error" in response) {
      rt.emit(`::warning::The earlier Codex session could not be restored: ${jsonDumps(response.error)}`);
      return "lost";
    }
    compactRequested = true;
    send({ id: 3, method: "thread/compact/start", params: { threadId: sessionId } });
    response = await receive(3);
    if ("error" in response) throw new Error(jsonDumps(response.error));
    if (!completed) await receive();
    return "compacted";
  } catch (error) {
    rt.emit(`::warning::Could not compact the Codex session: ${errorText(error)}`);
    return "skipped";
  } finally {
    if (server !== undefined) {
      try {
        await stop(server, rt, deadline);
      } catch (error) {
        rt.emit(`::warning::Could not close the Codex app-server: ${errorText(error)}`);
      }
    }
  }
}

async function execReview(
  args: RunArgs,
  prompt: string,
  path: string,
  previous: SessionRecord | null,
  resume: boolean,
  rt: Runtime,
): Promise<[number, boolean, number]> {
  const command = ["exec"];
  if (resume) command.push("resume", previous!.session_id);
  command.push(...args.agentArgs);
  command.push("--json", "--output-schema", args.schema, "-o", args.record, "-");
  // A failed child must not leave a preceding run's final message at this path.
  unlinkMissingOk(args.record);
  const child = rt.spawn("codex", command, { cwd: rt.cwd(), stdio: ["pipe", "pipe", "inherit"] });
  await started(child);
  let current: SessionRecord | null = resume ? { ...previous! } : null;
  let completed = false;
  let calls = 0;
  feedPrompt(child, prompt);
  try {
    const events = openSync(args.events, "a");
    try {
      await forEachLine(child.stdout!, (line) => {
        writeSync(events, line);
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!isObject(event)) return;
        if (event.type === "thread.started" && event.thread_id) {
          current = { session_id: event.thread_id as string, head: resume ? previous!.head : null };
          writeJson(path, current);
        } else if (event.type === "turn.completed") {
          completed = true;
        } else if (isRepoqlCall(event)) {
          calls += 1;
        }
      });
    } finally {
      closeSync(events);
    }
    const code = await exited(child);
    if (code === 0 && current !== null) {
      (current as SessionRecord).head = args.head;
      writeJson(path, current);
    }
    return [code, completed, calls];
  } finally {
    await stop(child, rt);
  }
}

export async function run(args: RunArgs, rt: Runtime): Promise<number> {
  const path = sessionPath(args.repo, args.pr, rt.environ);
  const existed = existsSync(path);
  let previous: SessionRecord | null = null;
  let broken = false;
  if (existed) {
    try {
      previous = readSession(path);
    } catch (error) {
      if (!isOsError(error) && !isValueError(error)) throw error;
      broken = true;
      rt.emit(`::warning::Could not read the earlier Codex session: ${errorText(error)}`);
    }
  }
  const lastHead = previous ? previous.head : null;
  let session = args.fresh && existed ? "fresh" : broken ? "lost" : "new";
  const continuing = previous !== null && !args.fresh;
  if (continuing) session = "continued";
  // The calls of the turn whose record is published, never of a turn it replaced.
  let calls = 0;
  try {
    writeFileSync(args.events, "", "utf8");
    if (continuing) {
      if ((await compact(previous!.session_id, rt, configOverrides(args.agentArgs))) === "lost") {
        session = "lost";
      } else {
        const prompt = readFileSync(args.again, "utf8").replaceAll("{last_head}", lastHead || "unknown");
        let code: number, completed: boolean;
        [code, completed, calls] = await execReview(args, prompt, path, previous, true, rt);
        if (code === 0 || completed) return code;
        session = "lost";
      }
    }
    const prompt = readFileSync(args.first, "utf8");
    let code: number;
    [code, , calls] = await execReview(args, prompt, path, previous, false, rt);
    return code;
  } catch (error) {
    if (!isOsError(error)) throw error;
    rt.emit(`::warning::Could not run the Codex review: ${errorText(error)}`);
    return 1;
  } finally {
    writeJson(args.sight, { session, last_head: lastHead, repoql_calls: calls });
  }
}

/** Install Codex when it is missing, and sign it in from an API key when it is not signed in. */
export async function prepare(rt: Runtime): Promise<number> {
  try {
    if (rt.which("codex") === null) {
      rt.emit("Installing Codex.");
      if ((await runCommand(rt, "npm", ["install", "--global", "@openai/codex"])) || rt.which("codex") === null) {
        rt.emit("::error::Codex could not be installed with npm. Install it before the review action.");
        return 1;
      }
    }
    if ((await runCommand(rt, "codex", ["login", "status"], "ignore")) === 0) return 0;
    const key = rt.environ.OPENAI_API_KEY || rt.environ.CODEX_API_KEY;
    if (key && (await runCommand(rt, "codex", ["login", "--with-api-key"], { input: key })) === 0) return 0;
  } catch (error) {
    if (!isOsError(error)) throw error;
    rt.emit(`::error::Codex could not be prepared: ${errorText(error)}`);
    return 1;
  }
  rt.emit(
    "::error::Codex is not signed in. Set OPENAI_API_KEY from a secret on the job, or sign in on a " +
      "self-hosted runner with: codex login --device-auth",
  );
  return 1;
}

export async function archive(repo: string, number: number, rt: Runtime): Promise<number> {
  const path = sessionPath(repo, number, rt.environ);
  if (!existsSync(path)) {
    rt.emit(`No Codex review session to archive for ${repo}#${number}.`);
    return 0;
  }
  try {
    const session = readSession(path);
    const child = rt.spawn("codex", ["archive", session.session_id], { cwd: rt.cwd(), stdio: ["ignore", "ignore", "inherit"] });
    await started(child);
    await exited(child);
  } catch (error) {
    if (!isOsError(error) && !isValueError(error)) throw error;
  } finally {
    try {
      unlinkMissingOk(path);
    } catch (error) {
      if (!isOsError(error)) throw error;
      rt.emit(`::warning::Could not delete the Codex session record: ${errorText(error)}`);
    }
  }
  rt.emit(`Archived Codex review session for ${repo}#${number}.`);
  return 0;
}

/** The model and the rql as Codex arguments, before the caller's own. */
export function wiredArgs(args: RunArgs): string[] {
  const wired: string[] = [];
  if (args.model) wired.push("-m", args.model);
  if (args.rql) {
    // As -c pairs, so compaction's app-server starts the same MCP server.
    wired.push("-c", `mcp_servers.repoql.command=${jsonDumps(args.rql)}`, "-c", 'mcp_servers.repoql.args=["mcp"]');
  }
  return [...wired, ...args.agentArgs];
}

export function createCodexAdapter(deps: AdapterDeps = {}): Adapter {
  const rt = runtime(deps, 300_000);
  return {
    name: "codex",
    prepare: () => prepare(rt),
    stateDirs: () => stateDirs(rt.environ),
    run: (args) => run({ ...args, agentArgs: wiredArgs(args) }, rt),
    archive: (repo, pr) => archive(repo, pr, rt),
  };
}
