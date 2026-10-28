/**
 * Run and archive persistent opencode 2.x review sessions across pull request pushes.
 *
 * One of the harness adapters: the only file that knows opencode. Every adapter takes the same `run`, `archive` and
 * `state-dirs` commands, writes the record the harness returned, and writes the sight file the gate and the renderer
 * read.
 *
 * opencode differs from the other harnesses in four ways this file absorbs. It has no structured output, so the
 * prompt carries the schema and the record is the final text. It compacts a session itself as the session grows, so
 * no compaction is asked for. `--session <id>` creates a session that does not exist, so a lost session is found by
 * exporting it first. And it keeps sessions in its database beside its sign-ins, so what a runner keeps between
 * reviews is the session's own export, which is text redaction can read, and never the database.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  type Adapter,
  type AdapterDeps,
  type RunArgs,
  type Runtime,
  type SessionRecord,
  collect,
  errorText,
  exited,
  feedPrompt,
  forEachLine,
  isObject,
  isOsError,
  isValueError,
  readSession,
  running,
  runtime,
  sessionRecordPath,
  started,
  unlinkMissingOk,
  waitExit,
  writeJson,
} from "./adapter.js";
import { OPENCODE } from "../credentials.js";

/** Provider keys opencode reads from the environment; any one lets it reach a model without a person. */
export const CREDENTIALS = OPENCODE;

/** The 2.x CLI on npm; the 1.x line is `opencode-ai`, which this adapter does not drive. */
export const PACKAGE = "@opencode/cli";

export function opencodeData(environ: NodeJS.ProcessEnv): string {
  return join(environ.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

export function sessionPath(repo: string, number: number, environ: NodeJS.ProcessEnv): string {
  return sessionRecordPath(opencodeData(environ), repo, number);
}

/** The session's export, beside its record. */
export function transcriptPath(repo: string, number: number, environ: NodeJS.ProcessEnv): string {
  return sessionPath(repo, number, environ).replace(/\.json$/, ".transcript.json");
}

/**
 * The directories a runner must keep between reviews for a session to continue: the records and the exports, never
 * opencode's database, which holds its sign-ins too.
 */
export function stateDirs(environ: NodeJS.ProcessEnv): string[] {
  return [join(opencodeData(environ), "review-sessions")];
}

/**
 * The environment every opencode child runs in: the repoql MCP server with code mode off, so each RepoQL call is its
 * own tool call the gate can count.
 */
export function childEnvironment(environ: NodeJS.ProcessEnv, rql?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...environ };
  if (rql) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      mcp: { repoql: { type: "local", command: [rql, "mcp"], codemode: false } },
    });
  }
  return env;
}

/** What opencode is told about the answer, since it cannot be held to a schema. */
export function answerInstruction(schema: string): string {
  return (
    "\n\nWhen you have finished, your final message is the review record and nothing else: one JSON object that " +
    `matches the JSON Schema in ${schema}. Write no other text and no code fence around it.\n`
  );
}

/** The record in a final text: the JSON object itself, or one inside a code fence. */
export function recordFrom(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)?.[1];
  for (const candidate of [trimmed, fenced]) {
    if (candidate === undefined) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch {
      continue;
    }
  }
  return null;
}

function eventOf(line: string): Record<string, unknown> | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isObject(event) ? event : undefined;
}

/** Run a short opencode command with its output captured; resolve with its exit code and output. */
async function capture(rt: Runtime, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; text: string }> {
  const child = rt.spawn("opencode", args, { cwd: rt.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  await started(child);
  const out = collect(child.stdout);
  const err = collect(child.stderr);
  const [code] = await Promise.all([exited(child), out.done, err.done]);
  return { code, stdout: out.text(), text: out.text() + err.text() };
}

/** Whether opencode still holds the session: `--session` would otherwise start a new one under the same id. */
export async function sessionExists(sessionId: string, rt: Runtime, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    return (await capture(rt, ["session", "export", sessionId, "--standalone"], env)).code === 0;
  } catch (error) {
    if (!isOsError(error)) throw error;
    return false;
  }
}

/**
 * Bring back a session opencode no longer holds, from the export the last review kept; return the id it holds it by,
 * or null when there is nothing to bring back.
 */
export async function restoreSession(sessionId: string, transcript: string, rt: Runtime, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (await sessionExists(sessionId, rt, env)) return sessionId;
  if (!existsSync(transcript)) return null;
  try {
    const imported = await capture(rt, ["session", "import", transcript, "--directory", rt.cwd(), "--standalone"], env);
    const id = /Imported session: ([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(imported.text)?.[1] ?? sessionId;
    return imported.code === 0 && (await sessionExists(id, rt, env)) ? id : null;
  } catch (error) {
    if (!isOsError(error)) throw error;
    return null;
  }
}

/** Keep the session's export beside its record, for the next review to bring back. */
export async function keepSession(sessionId: string, transcript: string, rt: Runtime, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const exported = await capture(rt, ["session", "export", sessionId, "--standalone"], env);
    if (exported.code === 0 && exported.stdout.trim()) {
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, exported.stdout, "utf8");
    } else {
      rt.emit("::warning::The opencode session could not be exported; the next review on another runner starts a new one.");
    }
  } catch (error) {
    if (!isOsError(error)) throw error;
    rt.emit(`::warning::The opencode session could not be exported: ${errorText(error)}`);
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
  const command = ["run", "--standalone", "--format", "json", "--auto"];
  if (resume) command.push("--session", previous!.session_id);
  command.push(...args.agentArgs);
  // A failed child must not leave a preceding run's final message at this path.
  unlinkMissingOk(args.record);
  const child = rt.spawn("opencode", command, {
    cwd: rt.cwd(),
    env: childEnvironment(rt.environ, args.rql),
    stdio: ["pipe", "pipe", "inherit"],
  });
  await started(child);
  let current: SessionRecord | null = resume ? { ...previous! } : null;
  let failed = false;
  let calls = 0;
  let text = "";
  // The message is read from standard input, with the schema it must answer in.
  feedPrompt(child, prompt + answerInstruction(args.schema));
  try {
    const events = openSync(args.events, "a");
    try {
      await forEachLine(child.stdout!, (line) => {
        writeSync(events, line);
        const event = eventOf(line);
        if (event === undefined) return;
        const sessionId = event.sessionID;
        if (current === null && typeof sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) {
          current = { session_id: sessionId, head: null };
          writeJson(path, current);
        }
        const part = isObject(event.part) ? event.part : {};
        // A call counts once it returned without error: a failed call
        // followed by plain reads is no use of RepoQL.
        if (event.type === "tool_use" && String(part.tool ?? "").startsWith("repoql_")) {
          const state = isObject(part.state) ? part.state : {};
          if (state.status === "completed") calls += 1;
        }
        // Each text event is a whole block; the record is the last one.
        if (event.type === "text" && typeof part.text === "string" && part.text.trim()) text = part.text;
        if (event.type === "error") failed = true;
      });
    } finally {
      closeSync(events);
    }
    const code = await exited(child);
    const completed = code === 0 && !failed && text !== "";
    if (text) {
      const record = recordFrom(text);
      // Not the record's shape: the renderer publishes it as undetermined.
      if (record) writeJson(args.record, record);
      else writeFileSync(args.record, text, "utf8");
    }
    if (completed && current !== null) {
      (current as SessionRecord).head = args.head;
      writeJson(path, current);
    }
    return [code, completed, calls];
  } finally {
    try {
      if (running(child)) {
        child.kill("SIGTERM");
        if (!(await waitExit(child, rt.timeouts.stop))) child.kill("SIGKILL");
      }
    } catch (error) {
      if (!isOsError(error)) throw error;
      child.kill("SIGKILL");
    }
    for (const stream of [child.stdin, child.stdout]) stream?.destroy();
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
      rt.emit(`::warning::Could not read the earlier opencode session: ${errorText(error)}`);
    }
  }
  const lastHead = previous ? previous.head : null;
  let session = args.fresh && existed ? "fresh" : broken ? "lost" : "new";
  const continuing = previous !== null && !args.fresh;
  if (continuing) session = "continued";
  // The calls of the turn whose record is published, never of a turn it replaced.
  let calls = 0;
  const transcript = transcriptPath(args.repo, args.pr, rt.environ);
  const env = childEnvironment(rt.environ);
  try {
    writeFileSync(args.events, "", "utf8");
    if (continuing) {
      const held = await restoreSession(previous!.session_id, transcript, rt, env);
      if (held === null) {
        rt.emit("::warning::The earlier opencode session could not be restored: opencode no longer holds it, and no export of it was kept.");
        session = "lost";
      } else {
        previous = { ...previous!, session_id: held };
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
    rt.emit(`::warning::Could not run the opencode review: ${errorText(error)}`);
    return 1;
  } finally {
    try {
      const kept = existsSync(path) ? readSession(path) : null;
      if (kept) await keepSession(kept.session_id, transcript, rt, env);
    } catch (error) {
      if (!isOsError(error) && !isValueError(error)) throw error;
    }
    writeJson(args.sight, { session, last_head: lastHead, repoql_calls: calls });
  }
}

/** Install opencode 2.x when it is missing or older, and require a credential it can use unattended. */
export async function prepare(rt: Runtime): Promise<number> {
  const env = childEnvironment(rt.environ);
  try {
    const version = rt.which("opencode") === null ? null : (await capture(rt, ["--version"], env)).text.trim();
    const major = Number(/(\d+)\.\d+/.exec(version ?? "")?.[1] ?? "0");
    if (major < 2) {
      rt.emit(version ? `opencode ${version} is older than 2; installing ${PACKAGE}.` : `Installing ${PACKAGE}.`);
      const child = rt.spawn("npm", ["install", "--global", PACKAGE], { cwd: rt.cwd(), stdio: ["ignore", "inherit", "inherit"] });
      await started(child);
      if ((await exited(child)) !== 0 || rt.which("opencode") === null) {
        rt.emit(`::error::opencode 2 could not be installed with npm (${PACKAGE}). Install it before the review action.`);
        return 1;
      }
    }
    if (CREDENTIALS.some((name) => rt.environ[name])) return 0;
    // A credential stored with `opencode auth login` on a self-hosted runner. `auth list` exits 0 with none, so its
    // words are read.
    const listed = await capture(rt, ["auth", "list", "--standalone"], env);
    if (listed.code === 0 && listed.text.trim() && !listed.text.includes("No authenticated integrations")) return 0;
  } catch (error) {
    if (!isOsError(error)) throw error;
    rt.emit(`::error::opencode could not be prepared: ${errorText(error)}`);
    return 1;
  }
  rt.emit(
    "::error::opencode has no model credential. Set the provider's key from a secret on the job, such as " +
      "ANTHROPIC_API_KEY or OPENAI_API_KEY, or OPENCODE_API_KEY for OpenCode Zen, and pick the model with the review " +
      "action's model input, as provider/model.",
  );
  return 1;
}

/** Delete the session from opencode's database, then the record. */
export async function archive(repo: string, number: number, rt: Runtime): Promise<number> {
  const path = sessionPath(repo, number, rt.environ);
  if (!existsSync(path)) {
    rt.emit(`No opencode review session to archive for ${repo}#${number}.`);
    return 0;
  }
  try {
    const session = readSession(path);
    await capture(rt, ["session", "delete", session.session_id, "--standalone"], childEnvironment(rt.environ));
  } catch (error) {
    if (!isOsError(error) && !isValueError(error)) throw error;
  } finally {
    try {
      unlinkMissingOk(path);
      unlinkMissingOk(transcriptPath(repo, number, rt.environ));
    } catch (error) {
      if (!isOsError(error)) throw error;
      rt.emit(`::warning::Could not delete the opencode session record: ${errorText(error)}`);
    }
  }
  rt.emit(`Archived opencode review session for ${repo}#${number}.`);
  return 0;
}

/** The model as an opencode argument, before the caller's own. The rql reaches opencode through its environment. */
export function wiredArgs(args: RunArgs): string[] {
  return [...(args.model ? ["--model", args.model] : []), ...args.agentArgs];
}

export function createOpencodeAdapter(deps: AdapterDeps = {}): Adapter {
  const rt = runtime(deps, 0);
  return {
    name: "opencode",
    prepare: () => prepare(rt),
    stateDirs: () => stateDirs(rt.environ),
    run: (args) => run({ ...args, agentArgs: wiredArgs(args) }, rt),
    archive: (repo, pr) => archive(repo, pr, rt),
  };
}
