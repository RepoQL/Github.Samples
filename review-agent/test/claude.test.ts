/** Verify Claude Code session persistence, structured output and call counting with in-memory child processes. */

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Spawn, adapterMain, writeJson } from "../src/harness/adapter.js";
import { COMPACT, createClaudeAdapter, sessionPath } from "../src/harness/claude.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("No real process");
  },
}));

const ROOT = join(import.meta.dirname, "..");
const fixture = (name: string): any => JSON.parse(readFileSync(join(ROOT, "fixtures", name), "utf8"));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const OLD_ID = "22222222-2222-4222-8222-222222222222";

type Event = string | Record<string, unknown>;

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });

const toolUse = (identifier: string, name = "mcp__repoql__read") => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: identifier, name }] },
});

const toolResult = (identifier: string, isError: boolean | null = null) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: identifier, is_error: isError }] },
});

function result(structured?: unknown, text?: string, error = false): Record<string, unknown> {
  const event: Record<string, unknown> = { type: "result", subtype: error ? "error_during_execution" : "success", is_error: error };
  if (structured !== undefined) event.structured_output = structured;
  if (text !== undefined) event.result = text;
  return event;
}

interface Behavior {
  code?: number;
  events?: Event[];
  stderr?: string;
  hang?: boolean;
  afterInit?: () => void;
}

async function consumed(stream: PassThrough): Promise<void> {
  while (stream.writableLength > 0 || stream.readableLength > 0) await tick();
  await tick();
}

/** A turn's stream-json output, or a compaction's whole output and error. */
class FakeProcess extends EventEmitter {
  private readonly input = new PassThrough();
  readonly stdin: PassThrough | null;
  readonly stdout = new PassThrough();
  readonly stderr: PassThrough | null;
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  text = "";

  constructor(
    readonly command: string[],
    readonly options: SpawnOptions,
    readonly behavior: Behavior,
  ) {
    super();
    const stdio = options.stdio as string[];
    this.stdin = stdio[0] === "pipe" ? this.input : null;
    this.stderr = stdio[2] === "pipe" ? new PassThrough() : null;
    if (!this.stdin) this.input.end();
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => (this.text += chunk));
    process.nextTick(() => this.emit("spawn"));
    void (this.stdin ? this.turn() : this.communicate());
  }

  private async turn(): Promise<void> {
    const supplied = await Promise.race([
      new Promise<boolean>((resolve) => this.input.once("end", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!supplied) return void this.stdout.destroy(new Error("Prompt was not supplied"));
    for (const event of this.behavior.events ?? []) {
      this.stdout.write(typeof event === "string" ? event + "\n" : JSON.stringify(event) + "\n");
      if (typeof event !== "string" && event.subtype === "init" && this.behavior.afterInit) {
        await consumed(this.stdout);
        try {
          this.behavior.afterInit();
        } catch (error) {
          return void this.stdout.destroy(error as Error);
        }
      }
    }
    this.stdout.end();
    await consumed(this.stdout);
    this.exit(this.behavior.code ?? 0, null);
  }

  private communicate(): void {
    if (this.behavior.hang) return;
    for (const event of this.behavior.events ?? []) this.stdout.write(JSON.stringify(event) + "\n");
    this.stdout.end();
    this.stderr?.end(this.behavior.stderr ?? "");
    this.exit(this.behavior.code ?? 0, null);
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    process.nextTick(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (signal === "SIGKILL") this.killed = true;
    if (this.exitCode === null && this.signalCode === null) {
      if (!this.stdout.writableEnded) this.stdout.end();
      if (this.stderr && !this.stderr.writableEnded) this.stderr.end();
      this.exit(null, signal);
    }
    return true;
  }
}

class FailedProcess extends EventEmitter {
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  exitCode: number | null = null;
  signalCode = null;

  constructor(error: Error) {
    super();
    process.nextTick(() => {
      this.exitCode = -2;
      this.emit("error", error);
      this.emit("close", -2, null);
    });
  }

  kill(): boolean {
    return false;
  }
}

function osError(message: string, code = "ENOENT"): Error {
  return Object.assign(new Error(message), { code, errno: -2, syscall: "spawn claude", path: "claude" });
}

class FakeClaude {
  readonly behaviors: (Behavior | Error)[];
  readonly processes: FakeProcess[] = [];

  constructor(behaviors: (Behavior | Error)[] = []) {
    this.behaviors = [...behaviors];
  }

  readonly spawn = ((command: string, args: string[], options: SpawnOptions) => {
    expect(command).toBe("claude");
    const behavior = this.behaviors.shift() ?? {};
    if (behavior instanceof Error) return new FailedProcess(behavior);
    const child = new FakeProcess([command, ...args], options, behavior);
    this.processes.push(child);
    return child;
  }) as unknown as Spawn;
}

const COMPACTED: Behavior = { events: [init(OLD_ID), { type: "system", subtype: "compact_boundary" }, result()] };

describe("claude session", () => {
  let directory: string;
  let environ: NodeJS.ProcessEnv;
  let path: string;
  let first: string, again: string, record: string, events: string, sight: string;
  let messages: string[];
  const schema = join(ROOT, "record.schema.json");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "claude-session-"));
    environ = { CLAUDE_CONFIG_DIR: join(directory, "claude-home") };
    path = sessionPath("O/R", 3, environ);
    first = join(directory, "first.md");
    again = join(directory, "again.md");
    writeFileSync(first, "First review.\n");
    writeFileSync(again, "Review changes since {last_head}.\n");
    record = join(directory, "record.json");
    events = join(directory, "events.jsonl");
    sight = join(directory, "sight.json");
    messages = [];
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const io = () => ({ emit: (line: string) => messages.push(line), environ });
  const adapter = (runner?: FakeClaude) =>
    createClaudeAdapter({
      ...(runner ? { spawn: runner.spawn } : {}),
      environ,
      emit: (line) => messages.push(line),
      timeouts: { compact: 50 },
    });
  const argumentsFor = (extra: string[] = [], fresh = false) => {
    const args = ["run", "--repo", "O/R", "--pr", "3", "--head", "new-head", "--first", first, "--again", again,
      "--schema", schema, "--record", record, "--events", events, "--sight", sight];
    if (fresh) args.push("--fresh");
    return [...args, ...extra];
  };
  const runSession = (runner: FakeClaude, extra: string[] = [], fresh = false) =>
    adapterMain(adapter(runner), argumentsFor(extra, fresh), io());
  const previous = (head: string | null = "old-head") => writeJson(path, { session_id: OLD_ID, head });
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const turn = (sessionId: string, ...rest: Event[]): Behavior => ({ events: [init(sessionId), ...rest, result(fixture("record.json"))] });

  it("new session is saved at init and its head after success", async () => {
    const seen: boolean[] = [];
    const behavior = turn("new-id");
    behavior.afterInit = () => {
      expect(read(path)).toEqual({ session_id: "new-id", head: null });
      expect(existsSync(record)).toBe(false);
      seen.push(true);
    };
    const runner = new FakeClaude([behavior]);
    expect(await runSession(runner, ["--model", "opus", "--rql", "/opt/rql", "--", "--max-turns", "9"])).toBe(0);
    expect(seen).toEqual([true]);
    expect(read(path)).toEqual({ session_id: "new-id", head: "new-head" });
    expect(read(sight)).toEqual({ session: "new", last_head: null, repoql_calls: 0 });
    expect(read(record)).toEqual(fixture("record.json"));
    const command = runner.processes[0]!.command;
    expect(command.slice(0, 3)).toEqual(["claude", "-p", "--session-id"]);
    const schemaText = readFileSync(schema, "utf8");
    // Python's json.dumps spelling, byte for byte.
    const mcp = '{"mcpServers": {"repoql": {"command": "/opt/rql", "args": ["mcp"]}}}';
    expect(command.slice(4)).toEqual(["--output-format", "stream-json", "--verbose", "--json-schema", schemaText,
      "--permission-mode", "bypassPermissions", "--model", "opus", "--strict-mcp-config", "--mcp-config", mcp,
      "--max-turns", "9"]);
    expect(runner.processes[0]!.text).toBe("First review.\n");
  });

  it("only repoql calls that returned without error are counted", async () => {
    const stream = [toolUse("a"), toolResult("a"), toolUse("b"), toolResult("b", true), toolUse("c", "Bash"),
      toolResult("c"), toolUse("d"), toolResult("a")];
    expect(await runSession(new FakeClaude([turn("new-id", ...stream)]))).toBe(0);
    expect(read(sight).repoql_calls).toBe(1);
  });

  it("continue compacts then resumes with the last head", async () => {
    previous();
    const runner = new FakeClaude([COMPACTED, turn(OLD_ID, toolUse("a"), toolResult("a"))]);
    expect(await runSession(runner)).toBe(0);
    const [compaction, resumed] = runner.processes as [FakeProcess, FakeProcess];
    expect(compaction.command).toEqual(["claude", "-p", "--resume", OLD_ID, "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", COMPACT]);
    expect(resumed.command.slice(0, 4)).toEqual(["claude", "-p", "--resume", OLD_ID]);
    expect(resumed.text).toBe("Review changes since old-head.\n");
    expect(read(sight)).toEqual({ session: "continued", last_head: "old-head", repoql_calls: 1 });
    expect(read(path)).toEqual({ session_id: OLD_ID, head: "new-head" });
  });

  it("a conversation claude cannot find is lost and replaced", async () => {
    previous();
    const runner = new FakeClaude([{ code: 1, stderr: "No conversation found with session ID: x" }, turn("new-id")]);
    expect(await runSession(runner)).toBe(0);
    expect(runner.processes).toHaveLength(2);
    expect(runner.processes[1]!.command).toContain("--session-id");
    expect(read(sight)).toEqual({ session: "lost", last_head: "old-head", repoql_calls: 0 });
    expect(read(path).session_id).toBe("new-id");
  });

  it("a failed or slow compaction does not stop the review", async () => {
    for (const compaction of [{ code: 2, stderr: "rate limited" }, { hang: true }, osError("spawn claude ENOENT")]) {
      previous();
      const runner = new FakeClaude([compaction, turn(OLD_ID)]);
      expect(await runSession(runner), String(compaction)).toBe(0);
      expect(read(sight).session).toBe("continued");
    }
  });

  it("a compaction past its time limit is killed and skipped", async () => {
    previous();
    const runner = new FakeClaude([{ hang: true }, turn(OLD_ID)]);
    const begun = performance.now();
    expect(await runSession(runner)).toBe(0);
    expect(performance.now() - begun).toBeLessThan(2000);
    expect(runner.processes[0]!.killed).toBe(true);
    expect(messages).toContain("::warning::Could not compact the Claude Code session: it exceeded its time limit");
  });

  it("a resumed turn that fails falls back to a new session", async () => {
    previous();
    const runner = new FakeClaude([COMPACTED, { events: [init(OLD_ID), toolUse("a"), toolResult("a")], code: 1 }, turn("new-id")]);
    expect(await runSession(runner)).toBe(0);
    expect(read(sight)).toEqual({ session: "lost", last_head: "old-head", repoql_calls: 0 });
    expect(readFileSync(events, "utf8").split("\n").filter((line) => line.includes('"init"'))).toHaveLength(2);
  });

  it("fresh starts a new session without compaction", async () => {
    previous();
    const runner = new FakeClaude([turn("new-id")]);
    expect(await runSession(runner, [], true)).toBe(0);
    expect(runner.processes).toHaveLength(1);
    expect(read(sight)).toEqual({ session: "fresh", last_head: "old-head", repoql_calls: 0 });
  });

  it("an unstructured answer is kept as text and a stale record removed", async () => {
    writeFileSync(record, "stale");
    const runner = new FakeClaude([{ events: [init("new-id"), result(undefined, "I could not finish.")] }]);
    expect(await runSession(runner)).toBe(0);
    expect(readFileSync(record, "utf8")).toBe("I could not finish.");
    writeFileSync(record, "stale");
    unlinkSync(path);
    expect(await runSession(new FakeClaude([{ events: [init("new-id")], code: 3 }]))).toBe(3);
    expect(existsSync(record)).toBe(false);
    expect(read(path).head).toBeNull();
  });

  it("missing claude writes sight", async () => {
    expect(await runSession(new FakeClaude([osError("spawn claude ENOENT")]))).toBe(1);
    expect(read(sight)).toEqual({ session: "new", last_head: null, repoql_calls: 0 });
  });

  it("archive deletes the record and the transcript", async () => {
    previous();
    const transcript = join(environ.CLAUDE_CONFIG_DIR as string, "projects", "-work-repo", `${OLD_ID}.jsonl`);
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, "{}\n");
    expect(await adapterMain(adapter(), ["archive", "--repo", "O/R", "--pr", "3"], io())).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(transcript)).toBe(false);
    expect(await adapter().archive("O/R", 3)).toBe(0);
    expect(messages.at(-1)).toBe("No Claude Code review session to archive for O/R#3.");
  });

  it("archive deletes nothing outside the transcripts when the record's id is not an id", async () => {
    const outside = join(directory, "outside.jsonl");
    writeFileSync(outside, "keep\n");
    writeJson(path, { session_id: "../../outside", head: "old-head" });
    expect(await adapter().archive("O/R", 3)).toBe(0);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("a record with an invalid id is lost and replaced", async () => {
    writeJson(path, { session_id: "-rf", head: "old-head" });
    const runner = new FakeClaude([turn("new-id")]);
    expect(await runSession(runner)).toBe(0);
    expect(runner.processes).toHaveLength(1);
    expect(read(sight).session).toBe("lost");
  });

  it("a tool call without an id is never counted", async () => {
    const unnamed = { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__repoql__read" }] } };
    const unmatched = { type: "user", message: { content: [{ type: "tool_result", is_error: false }] } };
    expect(await runSession(new FakeClaude([turn("new-id", unnamed as Event, unmatched as Event)]))).toBe(0);
    expect(read(sight).repoql_calls).toBe(0);
  });

  it("state dirs name the transcripts and their records", async () => {
    expect(await adapterMain(adapter(), ["state-dirs"], io())).toBe(0);
    const home = environ.CLAUDE_CONFIG_DIR as string;
    expect(messages).toEqual([join(home, "projects"), join(home, "review-sessions")]);
  });
});
