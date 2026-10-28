/**
 * Run and archive persistent Claude Code review sessions across pull request pushes.
 *
 * One of the harness adapters: the only file that knows Claude Code. Every adapter takes the same `run`, `archive` and
 * `state-dirs` commands, writes the record the harness returned, and writes the sight file the gate and the renderer
 * read. Each adapter stands alone, so a new one starts as a copy of this file.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Adapter,
  type AdapterDeps,
  type RunArgs,
  type Runtime,
  type SessionRecord,
  collect,
  errorText,
  exitCodeOf,
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
  splitlines,
  started,
  unlinkMissingOk,
  waitExit,
  writeJson,
} from "./adapter.js";
import { CLAUDE } from "../credentials.js";

// Any one of these lets Claude Code authenticate without a person.
export const CREDENTIALS = [...CLAUDE, "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

export const COMPACT =
  "/compact Keep what the next review of this pull request needs: your understanding of the change, " +
  "each check you ran and how to run it again, and every finding and decision you raised with its id " +
  "and state. Drop the raw output of tools.";

export function claudeHome(environ: NodeJS.ProcessEnv): string {
  return environ.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function sessionPath(repo: string, number: number, environ: NodeJS.ProcessEnv): string {
  return sessionRecordPath(claudeHome(environ), repo, number);
}

/** The directories a runner must keep between reviews for a session to continue. */
export function stateDirs(environ: NodeJS.ProcessEnv): string[] {
  const home = claudeHome(environ);
  return [join(home, "projects"), join(home, "review-sessions")];
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

function content(event: Record<string, unknown>, role: string): Record<string, unknown>[] {
  const message = event.type === role ? event.message : undefined;
  const blocks = isObject(message) ? message.content : undefined;
  return Array.isArray(blocks) ? blocks.filter(isObject) : [];
}

/** Return lost only when Claude Code says it has no such conversation. */
export async function compact(sessionId: string, rt: Runtime): Promise<"lost" | "compacted" | "skipped"> {
  try {
    // No MCP server: compaction calls no tools, and a repository's own
    // .mcp.json must not start here.
    const child = rt.spawn(
      "claude",
      ["-p", "--resume", sessionId, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", COMPACT],
      { cwd: rt.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    await started(child);
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    const communicated = Promise.all([out.done, err.done, exited(child)]);
    let timer: NodeJS.Timeout | undefined;
    const inTime = await Promise.race([
      communicated.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), rt.timeouts.compact))),
    ]);
    clearTimeout(timer);
    if (!inTime) {
      child.kill("SIGKILL");
      await communicated;
      rt.emit("::warning::Could not compact the Claude Code session: it exceeded its time limit");
      return "skipped";
    }
    if (err.text().includes("No conversation found")) {
      rt.emit(`::warning::The earlier Claude Code session could not be restored: ${err.text().trim()}`);
      return "lost";
    }
    const results = splitlines(out.text()).map(eventOf).filter((event) => event?.type === "result");
    const returncode = exitCodeOf(child);
    if (returncode === 0 && results.length && !results.at(-1)?.is_error) return "compacted";
    rt.emit(`::warning::Could not compact the Claude Code session: exit ${returncode} ${err.text().trim()}`);
    return "skipped";
  } catch (error) {
    if (!isOsError(error)) throw error;
    rt.emit(`::warning::Could not compact the Claude Code session: ${errorText(error)}`);
    return "skipped";
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
  const command = ["-p"];
  if (resume) command.push("--resume", previous!.session_id);
  else command.push("--session-id", randomUUID());
  const schema = readFileSync(args.schema, "utf8");
  command.push("--output-format", "stream-json", "--verbose", "--json-schema", schema, ...args.agentArgs);
  // A failed child must not leave a preceding run's final message at this path.
  unlinkMissingOk(args.record);
  const child = rt.spawn("claude", command, { cwd: rt.cwd(), stdio: ["pipe", "pipe", "inherit"] });
  await started(child);
  let current: SessionRecord | null = resume ? { ...previous! } : null;
  let completed = false;
  let calls = 0;
  const pending = new Set<unknown>();
  let final: Record<string, unknown> | null = null;
  feedPrompt(child, prompt);
  try {
    const events = openSync(args.events, "a");
    try {
      await forEachLine(child.stdout!, (line) => {
        writeSync(events, line);
        const event = eventOf(line);
        if (event === undefined) return;
        if (event.type === "system" && event.subtype === "init" && event.session_id) {
          current = { session_id: event.session_id as string, head: resume ? previous!.head : null };
          writeJson(path, current);
        }
        for (const block of content(event, "assistant")) {
          if (block.type === "tool_use" && String(block.name ?? "").startsWith("mcp__repoql__")) {
            if (typeof block.id === "string" && block.id) pending.add(block.id);
          }
        }
        // A call counts once it returned without error: a failed call
        // followed by plain reads is no use of RepoQL.
        for (const block of content(event, "user")) {
          const id = block.tool_use_id ?? null;
          if (block.type === "tool_result" && pending.has(id)) {
            pending.delete(id);
            if (!block.is_error) calls += 1;
          }
        }
        if (event.type === "result") {
          final = event;
          completed = event.subtype === "success" && !event.is_error;
        }
      });
    } finally {
      closeSync(events);
    }
    const code = await exited(child);
    const answer = final as Record<string, unknown> | null;
    if (answer !== null) {
      if (isObject(answer.structured_output)) {
        writeJson(args.record, answer.structured_output);
      } else if (typeof answer.result === "string" && answer.result) {
        // Not the record's shape: the renderer publishes it as undetermined.
        writeFileSync(args.record, answer.result, "utf8");
      }
    }
    if (code === 0 && completed && current !== null) {
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
      rt.emit(`::warning::Could not read the earlier Claude Code session: ${errorText(error)}`);
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
      if ((await compact(previous!.session_id, rt)) === "lost") {
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
    rt.emit(`::warning::Could not run the Claude Code review: ${errorText(error)}`);
    return 1;
  } finally {
    writeJson(args.sight, { session, last_head: lastHead, repoql_calls: calls });
  }
}

/** Install Claude Code when it is missing, and require a credential it can use unattended. */
export async function prepare(rt: Runtime): Promise<number> {
  try {
    if (rt.which("claude") === null) {
      rt.emit("Installing Claude Code.");
      if ((await runCommand(rt, "npm", ["install", "--global", "@anthropic-ai/claude-code"])) || rt.which("claude") === null) {
        rt.emit("::error::Claude Code could not be installed with npm. Install it before the review action.");
        return 1;
      }
    }
  } catch (error) {
    if (!isOsError(error)) throw error;
    rt.emit(`::error::Claude Code could not be prepared: ${errorText(error)}`);
    return 1;
  }
  if (CREDENTIALS.some((name) => rt.environ[name]) || existsSync(join(claudeHome(rt.environ), ".credentials.json"))) return 0;
  rt.emit(
    "::error::Claude Code has no credential. Set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from " +
      "`claude setup-token`, from a secret on the job.",
  );
  return 1;
}

/** Claude Code has no archive command: the record and the transcript are deleted. */
export async function archive(repo: string, number: number, rt: Runtime): Promise<number> {
  const path = sessionPath(repo, number, rt.environ);
  if (!existsSync(path)) {
    rt.emit(`No Claude Code review session to archive for ${repo}#${number}.`);
    return 0;
  }
  try {
    const session = readSession(path);
    const projects = join(claudeHome(rt.environ), "projects");
    for (const project of readdirSync(projects)) {
      if (project.startsWith(".")) continue;
      unlinkMissingOk(join(projects, project, `${session.session_id}.jsonl`));
    }
  } catch (error) {
    if (!isOsError(error) && !isValueError(error)) throw error;
  } finally {
    try {
      unlinkMissingOk(path);
    } catch (error) {
      if (!isOsError(error)) throw error;
      rt.emit(`::warning::Could not delete the Claude Code session record: ${errorText(error)}`);
    }
  }
  rt.emit(`Archived Claude Code review session for ${repo}#${number}.`);
  return 0;
}

/** The permission mode, the model and the rql as Claude Code arguments, before the caller's own. */
export function wiredArgs(args: RunArgs): string[] {
  // Unattended: a headless turn denies every tool it would otherwise ask
  // about. First, so the caller's own arguments override it.
  const wired = ["--permission-mode", "bypassPermissions"];
  if (args.model) wired.push("--model", args.model);
  if (args.rql) {
    // Only this server, so a repository's own .mcp.json cannot replace it;
    // the caller may add more with its own --mcp-config.
    wired.push("--strict-mcp-config", "--mcp-config", jsonDumps({ mcpServers: { repoql: { command: args.rql, args: ["mcp"] } } }));
  }
  return [...wired, ...args.agentArgs];
}

export function createClaudeAdapter(deps: AdapterDeps = {}): Adapter {
  const rt = runtime(deps, 600_000);
  return {
    name: "claude",
    prepare: () => prepare(rt),
    stateDirs: () => stateDirs(rt.environ),
    run: (args) => run({ ...args, agentArgs: wiredArgs(args) }, rt),
    archive: (repo, pr) => archive(repo, pr, rt),
  };
}
