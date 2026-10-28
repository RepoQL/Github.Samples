/** Verify Codex session persistence and JSON-RPC using in-memory child processes. */

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Spawn, adapterMain, writeJson } from "../src/harness/adapter.js";
import { compact, configOverrides, createCodexAdapter, sessionPath } from "../src/harness/codex.js";
import type { Runtime } from "../src/harness/adapter.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("No real process");
  },
}));

const ROOT = join(import.meta.dirname, "..");
const fixture = (name: string): any => JSON.parse(readFileSync(join(ROOT, "fixtures", name), "utf8"));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Resolve once everything written to the stream has been read by its consumer. */
async function consumed(stream: PassThrough): Promise<void> {
  while (stream.writableLength > 0 || stream.readableLength > 0) await tick();
  await tick();
}

type Event = string | Record<string, unknown>;

interface Behavior {
  code?: number;
  events?: Event[];
  afterStarted?: () => void;
  silent?: boolean;
  eof?: boolean;
  invalidJson?: boolean;
  errorId?: number;
  earlyCompletion?: boolean;
  noCompletion?: boolean;
  notification?: string;
  closesAfterCompactStart?: boolean;
  ignoresTerm?: boolean;
  /** Each event's line written in pieces, the last without its newline. */
  chunked?: boolean;
}

/** Model streaming exec output or a responsive app-server without spawning. */
class FakeProcess extends EventEmitter {
  private readonly input = new PassThrough();
  readonly stdin: PassThrough | null;
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  terminated = false;
  killed = false;
  readonly rpc: Record<string, any>[] = [];
  text = "";
  readonly spawnargs: string[];

  constructor(
    readonly command: string[],
    readonly options: SpawnOptions,
    readonly behavior: Behavior,
  ) {
    super();
    this.spawnargs = command;
    const piped = (options.stdio as string[])[0] === "pipe";
    this.stdin = piped ? this.input : null;
    if (!piped) this.input.end();
    this.input.setEncoding("utf8");
    process.nextTick(() => this.emit("spawn"));
    if (command[1] === "app-server") {
      let buffered = "";
      this.input.on("data", (chunk: string) => {
        this.text += chunk;
        buffered += chunk;
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          this.answer(JSON.parse(line));
        }
      });
    } else {
      this.input.on("data", (chunk: string) => (this.text += chunk));
      void this.exec();
    }
  }

  private put(message: string | null): void {
    if (this.stdout.writableEnded) return;
    if (message === null) this.stdout.end();
    else this.stdout.write(message);
  }

  private answer(message: Record<string, any>): void {
    this.rpc.push(message);
    if (!("id" in message)) return;
    if (this.behavior.silent) return;
    if (this.behavior.eof) return this.put(null);
    if (this.behavior.invalidJson) return this.put("not json\n");
    let response: Record<string, unknown> = { id: message.id, result: {} };
    if (this.behavior.errorId === message.id) response = { id: message.id, error: { message: "Cannot restore" } };
    if (message.id === 1 && this.behavior.earlyCompletion) this.put(JSON.stringify({ method: "turn/completed" }) + "\n");
    this.put(JSON.stringify(response) + "\n");
    if (message.id === 3 && !("error" in response) && !this.behavior.noCompletion) {
      this.put(JSON.stringify({ method: this.behavior.notification ?? "thread/compacted" }) + "\n");
    }
    if (message.id === 3 && this.behavior.closesAfterCompactStart) this.put(null);
  }

  private async exec(): Promise<void> {
    const supplied = await Promise.race([
      new Promise<boolean>((resolve) => this.input.once("end", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!supplied) return void this.stdout.destroy(new Error("Prompt was not supplied"));
    for (const event of this.behavior.events ?? []) {
      const line = typeof event === "string" ? event + "\n" : JSON.stringify(event) + "\n";
      if (this.behavior.chunked) {
        const middle = Math.floor(line.length / 2);
        this.stdout.write(line.slice(0, middle));
        await tick();
        this.stdout.write(line.slice(middle));
      } else {
        this.stdout.write(line);
      }
      if (typeof event !== "string" && event.type === "thread.started" && this.behavior.afterStarted) {
        await consumed(this.stdout);
        try {
          this.behavior.afterStarted();
        } catch (error) {
          return void this.stdout.destroy(error as Error);
        }
      }
    }
    const code = this.behavior.code ?? 0;
    if (code === 0 && this.command[1] === "exec") {
      const out = this.command[this.command.indexOf("-o") + 1] as string;
      writeFileSync(out, JSON.stringify(fixture("record.json")) + "\n");
    }
    this.stdout.end();
    await consumed(this.stdout);
    this.exit(code, null);
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
    if (signal === "SIGTERM") this.terminated = true;
    else this.killed = true;
    this.put(null);
    if (signal === "SIGTERM" && this.behavior.ignoresTerm) return true;
    if (this.exitCode === null && this.signalCode === null) this.exit(null, signal);
    return true;
  }
}

/** Failing to start, as a missing binary does: the error arrives as an event. */
class FailedProcess extends EventEmitter {
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  exitCode: number | null = null;
  signalCode = null;
  readonly spawnargs: string[] = [];

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

function enoent(name: string): Error {
  return Object.assign(new Error(`spawn ${name} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${name}`, path: name });
}

/** Capture spawn calls and supply configured fake child processes. */
class FakeCodex {
  readonly behaviors: (Behavior | Error)[];
  readonly processes: FakeProcess[] = [];
  readonly options: SpawnOptions[] = [];

  constructor(behaviors: (Behavior | Error)[] = []) {
    this.behaviors = [...behaviors];
  }

  readonly spawn = ((command: string, args: string[], options: SpawnOptions) => {
    expect(command).toBe("codex");
    const behavior = this.behaviors.shift() ?? {};
    if (behavior instanceof Error) return new FailedProcess(behavior);
    const child = new FakeProcess([command, ...args], options, behavior);
    this.processes.push(child);
    this.options.push(options);
    return child;
  }) as unknown as Spawn;
}

describe("codex session", () => {
  let directory: string;
  let environ: NodeJS.ProcessEnv;
  let path: string;
  let first: string, again: string, record: string, events: string, sight: string;
  let messages: string[];
  const newEvents: Record<string, unknown>[] = fixture("codex-events.json").new;
  const oldEvents: Record<string, unknown>[] = fixture("codex-events.json").continued;
  const oldId = oldEvents[0]!.thread_id as string;
  const newId = newEvents[0]!.thread_id as string;
  const schema = join(ROOT, "record.schema.json");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "codex-session-"));
    environ = { CODEX_HOME: join(directory, "codex-home") };
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
  const adapter = (runner: FakeCodex, timeouts = {}) =>
    createCodexAdapter({ spawn: runner.spawn, environ, emit: (line) => messages.push(line), timeouts });
  const rt = (runner: FakeCodex, compactMs = 300_000): Runtime => ({
    spawn: runner.spawn,
    which: () => null,
    environ,
    emit: (line) => messages.push(line),
    cwd: () => process.cwd(),
    timeouts: { compact: compactMs, stop: 5000 },
  });

  const argumentsFor = (fresh = false) => {
    const args = ["run", "--repo", "O/R", "--pr", "3", "--head", "new-head", "--first", first, "--again", again,
      "--schema", schema, "--record", record, "--events", events, "--sight", sight];
    if (fresh) args.push("--fresh");
    return [...args, "--", "-m", "gpt-6.1-sol", "-c", "key=value"];
  };
  const runSession = (runner: FakeCodex, fresh = false) => adapterMain(adapter(runner), argumentsFor(fresh), io());
  const previous = (head: string | null = "old-head") => writeJson(path, { session_id: oldId, head });
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

  it("new session saved before completion and head after success", async () => {
    const seen: boolean[] = [];
    const afterStarted = () => {
      expect(read(path)).toEqual({ session_id: newId, head: null });
      expect(readFileSync(events, "utf8")).toContain("thread.started");
      expect(existsSync(record)).toBe(false);
      seen.push(true);
    };
    const runner = new FakeCodex([{ events: newEvents, afterStarted }]);
    expect(await runSession(runner)).toBe(0);
    expect(seen).toEqual([true]);
    expect(read(path)).toEqual({ session_id: newId, head: "new-head" });
    expect(read(sight)).toEqual({ session: "new", last_head: null, repoql_calls: 0 });
    expect(read(record).verdict).toBe("approve");
    expect(runner.processes[0]!.text).toBe("First review.\n");
    expect(runner.processes[0]!.command).toEqual(["codex", "exec", "-m", "gpt-6.1-sol", "-c", "key=value", "--json",
      "--output-schema", schema, "-o", record, "-"]);
    expect((runner.options[0]!.stdio as string[])[2]).toBe("inherit");
    expect(readFileSync(events, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual(newEvents);
  });

  it("failed new turn still leaves session", async () => {
    const runner = new FakeCodex([{ events: newEvents.slice(0, 1), code: 9 }]);
    expect(await runSession(runner)).toBe(9);
    expect(read(path)).toEqual({ session_id: newId, head: null });
    expect(read(sight)).toEqual({ session: "new", last_head: null, repoql_calls: 0 });
  });

  it("continue compacts resumes and substitutes head", async () => {
    previous();
    const afterStarted = () => expect(read(path)).toEqual({ session_id: oldId, head: "old-head" });
    const runner = new FakeCodex([{}, { events: oldEvents, afterStarted }]);
    expect(await runSession(runner)).toBe(0);
    const [app, child] = runner.processes as [FakeProcess, FakeProcess];
    // The job's configuration and directory, so the resumed thread starts
    // its MCP servers with this job's rql, in this job's checkout.
    expect(app.command).toEqual(["codex", "app-server", "-c", "key=value"]);
    expect(app.rpc).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "codex-review", title: "codex review", version: "1" } } },
      { method: "initialized" },
      { id: 2, method: "thread/resume", params: { threadId: oldId, cwd: process.cwd() } },
      { id: 3, method: "thread/compact/start", params: { threadId: oldId } },
    ]);
    expect(app.terminated).toBe(true);
    expect(child.command.slice(0, 8)).toEqual(["codex", "exec", "resume", oldId, "-m", "gpt-6.1-sol", "-c", "key=value"]);
    expect(child.text).toBe("Review changes since old-head.\n");
    expect(read(sight)).toEqual({ session: "continued", last_head: "old-head", repoql_calls: 0 });
    expect(read(path).head).toBe("new-head");
  });

  it("sends JSON-RPC in Python's json.dumps spelling", async () => {
    const runner = new FakeCodex([{}]);
    expect(await compact(oldId, rt(runner))).toBe("compacted");
    expect(runner.processes[0]!.text.split("\n")[1]).toBe('{"method": "initialized"}');
  });

  it("config overrides keep only the configuration pairs", () => {
    expect(configOverrides(["-m", "model", "-c", "a=1", "--json", "--config", "b=2"])).toEqual(["-c", "a=1", "--config", "b=2"]);
  });

  it("continue null head substitutes unknown", async () => {
    previous(null);
    const runner = new FakeCodex([{}, { events: oldEvents }]);
    expect(await runSession(runner)).toBe(0);
    expect(runner.processes[1]!.text).toBe("Review changes since unknown.\n");
  });

  it("compaction failure does not stop review", async () => {
    for (const behavior of [{ errorId: 1 }, { errorId: 3 }, { invalidJson: true }, { eof: true }] as Behavior[]) {
      previous();
      const runner = new FakeCodex([behavior, { events: oldEvents }]);
      expect(await runSession(runner), JSON.stringify(behavior)).toBe(0);
      expect(read(sight).session).toBe("continued");
      expect(runner.processes.at(-1)!.command).toContain("resume");
      expect(runner.processes[0]!.terminated).toBe(true);
    }
    expect(messages.some((line) => line.startsWith("::warning::Could not compact"))).toBe(true);
  });

  it("compaction timeout is bounded and stops child", async () => {
    const runner = new FakeCodex([{ silent: true }]);
    const begun = performance.now();
    expect(await compact(oldId, rt(runner, 20))).toBe("skipped");
    expect(performance.now() - begun).toBeLessThan(2000);
    expect(runner.processes[0]!.terminated).toBe(true);
    expect(messages.at(-1)).toContain("time limit");
  });

  it("a child that ignores termination is killed after the grace", async () => {
    const runner = new FakeCodex([{ silent: true, ignoresTerm: true }]);
    const runtime = { ...rt(runner, 20), timeouts: { compact: 20, stop: 20 } };
    expect(await compact(oldId, runtime)).toBe("skipped");
    expect(runner.processes[0]!.terminated).toBe(true);
    expect(runner.processes[0]!.killed).toBe(true);
  });

  it("both compaction completion notifications", async () => {
    for (const notification of ["thread/compacted", "turn/completed"]) {
      const runner = new FakeCodex([{ notification }]);
      expect(await compact(oldId, rt(runner))).toBe("compacted");
    }
  });

  it("completion before compaction does not finish compaction", async () => {
    // The server ends its output once compaction is requested, so the outcome
    // does not depend on how fast the handshake runs.
    const runner = new FakeCodex([{ earlyCompletion: true, noCompletion: true, closesAfterCompactStart: true }]);
    expect(await compact(oldId, rt(runner))).toBe("skipped");
    expect(runner.processes[0]!.rpc.at(-1)!.method).toBe("thread/compact/start");
    expect(messages.at(-1)).toContain("closed its output");
  });

  it("resume error during compaction skips exec resume", async () => {
    previous();
    const runner = new FakeCodex([{ errorId: 2 }, { events: newEvents }]);
    expect(await runSession(runner)).toBe(0);
    expect(runner.processes.at(-1)!.command).not.toContain("resume");
    expect(runner.processes.at(-1)!.text).toBe("First review.\n");
    expect(read(sight)).toEqual({ session: "lost", last_head: "old-head", repoql_calls: 0 });
    expect(read(path).session_id).toBe(newId);
    expect(messages).toContain('::warning::The earlier Codex session could not be restored: {"message": "Cannot restore"}');
  });

  it("lost exec falls back keeps both event streams and passes args", async () => {
    previous();
    const newStarted = () => expect(read(path)).toEqual({ session_id: newId, head: null });
    const runner = new FakeCodex([
      {},
      { events: [oldEvents[0]!, "plain diagnostic", { type: "error" }], code: 5 },
      { events: newEvents, afterStarted: newStarted },
    ]);
    expect(await runSession(runner)).toBe(0);
    expect(read(sight).session).toBe("lost");
    const text = readFileSync(events, "utf8");
    expect(text).toContain(oldId);
    expect(text).toContain(newId);
    expect(text).toContain("plain diagnostic");
    for (const child of runner.processes.slice(1)) {
      expect(child.command).toContain("gpt-6.1-sol");
      expect(child.command).toContain("key=value");
    }
    expect(read(path).head).toBe("new-head");
  });

  it("nonzero with turn completed does not fall back or advance head", async () => {
    previous();
    const runner = new FakeCodex([{}, { events: oldEvents, code: 4 }]);
    expect(await runSession(runner)).toBe(4);
    expect(runner.processes).toHaveLength(2);
    expect(read(sight).session).toBe("continued");
    expect(read(path).head).toBe("old-head");
  });

  it("lost then failed new returns final exit code", async () => {
    previous();
    const runner = new FakeCodex([{}, { events: [], code: 4 }, { events: newEvents.slice(0, 1), code: 7 }]);
    expect(await runSession(runner)).toBe(7);
    expect(read(sight).session).toBe("lost");
    expect(read(path)).toEqual({ session_id: newId, head: null });
  });

  it("fresh replaces session without compaction", async () => {
    previous();
    const runner = new FakeCodex([{ events: newEvents }]);
    expect(await runSession(runner, true)).toBe(0);
    expect(runner.processes).toHaveLength(1);
    expect(read(sight)).toEqual({ session: "fresh", last_head: "old-head", repoql_calls: 0 });
    expect(read(path).session_id).toBe(newId);
  });

  it("fresh without existing session is new", async () => {
    const runner = new FakeCodex([{ events: newEvents }]);
    expect(await runSession(runner, true)).toBe(0);
    expect(read(sight).session).toBe("new");
  });

  it("events truncated between invocations and stale record removed", async () => {
    writeFileSync(events, "old event\n");
    writeFileSync(record, "old record");
    const runner = new FakeCodex([{ events: newEvents.slice(0, 1), code: 2 }]);
    expect(await runSession(runner)).toBe(2);
    expect(readFileSync(events, "utf8")).not.toContain("old event");
    expect(existsSync(record)).toBe(false);
  });

  it("non json and non object events are preserved and ignored", async () => {
    const runner = new FakeCodex([{ events: ["not JSON", "[]", ...newEvents] }]);
    expect(await runSession(runner)).toBe(0);
    expect(readFileSync(events, "utf8").startsWith("not JSON\n[]\n")).toBe(true);
  });

  it("lines split across chunks are read whole", async () => {
    const runner = new FakeCodex([{ events: newEvents, chunked: true }]);
    expect(await runSession(runner)).toBe(0);
    expect(read(path)).toEqual({ session_id: newId, head: "new-head" });
    expect(readFileSync(events, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual(newEvents);
  });

  it("a last line without a newline is still an event", async () => {
    const runner = new FakeCodex([{ events: [] }]);
    const spawn = runner.spawn;
    const unterminated = ((command: string, args: string[], options: SpawnOptions) => {
      const child = (spawn as unknown as (c: string, a: string[], o: SpawnOptions) => FakeProcess)(command, args, options);
      child.stdin!.once("end", () => child.stdout.write(JSON.stringify(newEvents[0])));
      return child;
    }) as unknown as Spawn;
    const code = await adapterMain(createCodexAdapter({ spawn: unterminated, environ, emit: (l) => messages.push(l) }), argumentsFor(), io());
    expect(code).toBe(0);
    expect(read(path)).toEqual({ session_id: newId, head: "new-head" });
  });

  it("corrupt session is lost and replaced", async () => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not JSON");
    const runner = new FakeCodex([{ events: newEvents }]);
    expect(await runSession(runner)).toBe(0);
    expect(read(sight).session).toBe("lost");
    expect(read(path).session_id).toBe(newId);
  });

  it("missing codex writes sight", async () => {
    const runner = new FakeCodex([enoent("codex")]);
    expect(await runSession(runner)).toBe(1);
    expect(read(sight)).toEqual({ session: "new", last_head: null, repoql_calls: 0 });
  });

  it("missing prompt writes sight", async () => {
    unlinkSync(first);
    const runner = new FakeCodex();
    expect(await runSession(runner)).toBe(1);
    expect(read(sight).session).toBe("new");
    expect(runner.processes).toHaveLength(0);
  });

  it("archive with record ignores exit code and deletes record", async () => {
    previous();
    const runner = new FakeCodex([{ code: 8 }]);
    expect(await adapterMain(adapter(runner), ["archive", "--repo", "O/R", "--pr", "3"], io())).toBe(0);
    expect(runner.processes[0]!.command).toEqual(["codex", "archive", oldId]);
    expect(existsSync(path)).toBe(false);
    expect(messages).toEqual(["Archived Codex review session for O/R#3."]);
  });

  it("archive without record does not run child", async () => {
    const runner = new FakeCodex();
    expect(await adapter(runner).archive("O/R", 3)).toBe(0);
    expect(runner.processes).toHaveLength(0);
    expect(messages).toEqual(["No Codex review session to archive for O/R#3."]);
  });

  it("archive missing binary or corrupt record exits zero", async () => {
    previous();
    let runner = new FakeCodex([enoent("codex")]);
    expect(await adapter(runner).archive("O/R", 3)).toBe(0);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "invalid");
    runner = new FakeCodex();
    expect(await adapter(runner).archive("O/R", 3)).toBe(0);
    expect(runner.processes).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  });

  it("only completed successful repoql calls are counted", async () => {
    const call = (item: Record<string, unknown> = {}) => ({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "repoql", status: "completed", error: null, ...item },
    });
    const stream = [newEvents[0]!, call(), call({ result: { isError: false } }), call({ result: { isError: true } }),
      call({ status: "failed" }), call({ error: { message: "boom" } }), call({ server: "other" }),
      { type: "item.started", item: { type: "mcp_tool_call", server: "repoql" } }, newEvents.at(-1)!];
    expect(await runSession(new FakeCodex([{ events: stream }]))).toBe(0);
    expect(read(sight).repoql_calls).toBe(2);
  });

  it("calls of a replaced turn are not counted", async () => {
    previous();
    const repoql = { type: "item.completed", item: { type: "mcp_tool_call", server: "repoql", status: "completed", error: null } };
    const runner = new FakeCodex([{}, { events: [oldEvents[0]!, repoql], code: 1 }, { events: newEvents }]);
    expect(await runSession(runner)).toBe(0);
    expect(read(sight)).toEqual({ session: "lost", last_head: "old-head", repoql_calls: 0 });
  });

  it("model and rql become codex arguments for exec and compaction", async () => {
    previous();
    const args = [...argumentsFor().slice(0, -5), "--model", "gpt-x", "--rql", "/opt/rql", "--", "-c", "key=value"];
    const runner = new FakeCodex([{}, { events: oldEvents }]);
    expect(await adapterMain(adapter(runner), args, io())).toBe(0);
    const wired = ["-m", "gpt-x", "-c", 'mcp_servers.repoql.command="/opt/rql"', "-c", 'mcp_servers.repoql.args=["mcp"]', "-c", "key=value"];
    const [app, child] = runner.processes as [FakeProcess, FakeProcess];
    expect(app.command).toEqual(["codex", "app-server", ...wired.slice(2)]);
    expect(child.command.slice(0, 4 + wired.length)).toEqual(["codex", "exec", "resume", oldId, ...wired]);
  });

  it("state dirs name the sessions and their records", async () => {
    expect(await adapterMain(adapter(new FakeCodex()), ["state-dirs"], io())).toBe(0);
    const home = environ.CODEX_HOME as string;
    expect(messages).toEqual([join(home, "sessions"), join(home, "review-sessions")]);
  });
});
