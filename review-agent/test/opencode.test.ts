/** Verify opencode 2.x session persistence, the record from the final text, and call counting with in-memory child processes. */

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Spawn, adapterMain, writeJson } from "../src/harness/adapter.js";
import {
  answerInstruction,
  childEnvironment,
  createOpencodeAdapter,
  recordFrom,
  reviewData,
  sessionPath,
} from "../src/harness/opencode.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("No real process");
  },
}));

const ROOT = join(import.meta.dirname, "..");
const RECORD = JSON.parse(readFileSync(join(ROOT, "fixtures", "record.json"), "utf8"));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const OLD_ID = "ses_old";

type Event = string | Record<string, unknown>;

const line = (type: string, sessionID: string, rest: Record<string, unknown> = {}) => ({ type, timestamp: 1, sessionID, ...rest });
const tool = (sessionID: string, name: string, status: "completed" | "error") =>
  line("tool_use", sessionID, { part: { type: "tool", tool: name, state: { status } } });
const text = (sessionID: string, value: string) => line("text", sessionID, { part: { type: "text", text: value } });

interface Behavior {
  code?: number;
  events?: Event[];
  output?: string;
}

/** A turn's JSON event lines when its input is a pipe, or a short command's whole output when it is not. */
class FakeProcess extends EventEmitter {
  private readonly input = new PassThrough();
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  text = "";

  constructor(
    readonly command: string[],
    readonly options: SpawnOptions,
    readonly behavior: Behavior,
  ) {
    super();
    const stdio = options.stdio as string[];
    this.stdin = stdio[0] === "pipe" ? this.input : null;
    this.stdout = stdio[1] === "pipe" ? new PassThrough() : null;
    this.stderr = stdio[2] === "pipe" ? new PassThrough() : null;
    if (!this.stdin) this.input.end();
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => (this.text += chunk));
    process.nextTick(() => this.emit("spawn"));
    void this.respond();
  }

  private async respond(): Promise<void> {
    if (this.stdin) await new Promise((resolve) => this.input.once("end", resolve));
    for (const event of this.behavior.events ?? []) {
      this.stdout?.write(typeof event === "string" ? event + "\n" : JSON.stringify(event) + "\n");
    }
    if (this.behavior.output) this.stdout?.write(this.behavior.output);
    this.stdout?.end();
    this.stderr?.end();
    while (this.stdout && this.stdout.readableLength > 0) await tick();
    await tick();
    this.exitCode = this.behavior.code ?? 0;
    process.nextTick(() => {
      this.emit("exit", this.exitCode, null);
      this.emit("close", this.exitCode, null);
    });
  }

  kill(): boolean {
    return true;
  }
}

class FakeOpencode {
  readonly processes: FakeProcess[] = [];
  constructor(private readonly behaviors: Behavior[] = []) {}

  readonly spawn = ((command: string, args: string[], options: SpawnOptions) => {
    const child = new FakeProcess([command, ...args], options, this.behaviors.shift() ?? {});
    this.processes.push(child);
    return child;
  }) as unknown as Spawn;
}

describe("opencode session", () => {
  let directory: string;
  let environ: NodeJS.ProcessEnv;
  let path: string;
  let first: string, again: string, record: string, events: string, sight: string;
  let messages: string[];
  const schema = join(ROOT, "record.schema.json");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "opencode-session-"));
    environ = { XDG_DATA_HOME: join(directory, "data"), PATH: "" };
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

  const adapter = (runner: FakeOpencode, which: (name: string) => string | null = () => "/bin/opencode") =>
    createOpencodeAdapter({ spawn: runner.spawn, which, environ, emit: (m) => messages.push(m), cwd: directory });
  const arguments_ = (extra: string[] = []) => [
    "run", "--repo", "O/R", "--pr", "3", "--head", "new-head", "--first", first, "--again", again, "--schema", schema,
    "--record", record, "--events", events, "--sight", sight, ...extra,
  ];
  const runSession = (runner: FakeOpencode, extra: string[] = []) =>
    adapterMain(adapter(runner), arguments_(extra), { emit: (m) => messages.push(m), environ });
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const turn = (sessionId: string, ...rest: Event[]): Behavior => ({
    events: [line("step_start", sessionId), ...rest, text(sessionId, JSON.stringify(RECORD)), line("step_finish", sessionId)],
  });

  it("starts a new session, records its id and head, and answers with the record", async () => {
    const runner = new FakeOpencode([turn("ses_new")]);
    expect(await runSession(runner, ["--model", "anthropic/claude-sonnet-5-5", "--rql", "/opt/rql", "--", "--agent", "build"])).toBe(0);
    const [child] = runner.processes;
    expect(child!.command).toEqual(["opencode", "run", "--standalone", "--format", "json", "--auto",
      "--model", "anthropic/claude-sonnet-5-5", "--agent", "build"]);
    expect(child!.text).toBe("First review.\n" + answerInstruction(schema));
    const env = child!.options.env as NodeJS.ProcessEnv;
    expect(env.OPENCODE_DB).toBe(join(reviewData(environ), "opencode.db"));
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { repoql: { type: "local", command: ["/opt/rql", "mcp"], codemode: false } },
    });
    expect(read(path)).toEqual({ session_id: "ses_new", head: "new-head" });
    expect(read(sight)).toEqual({ session: "new", last_head: null, repoql_calls: 0 });
    expect(read(record)).toEqual(RECORD);
    expect(readFileSync(events, "utf8")).toContain('"step_start"');
  });

  it("counts only repoql tool calls that completed", async () => {
    const runner = new FakeOpencode([turn("ses_new", tool("ses_new", "repoql_read", "completed"),
      tool("ses_new", "repoql_explore", "error"), tool("ses_new", "bash", "completed"), tool("ses_new", "repoql_query", "completed"))]);
    expect(await runSession(runner)).toBe(0);
    expect(read(sight).repoql_calls).toBe(2);
  });

  it("continues a session it still holds, with the last head in the prompt", async () => {
    writeJson(path, { session_id: OLD_ID, head: "old-head" });
    const runner = new FakeOpencode([{ code: 0, output: "{}" }, turn(OLD_ID, tool(OLD_ID, "repoql_read", "completed"))]);
    expect(await runSession(runner)).toBe(0);
    const [exported, resumed] = runner.processes;
    expect(exported!.command).toEqual(["opencode", "session", "export", OLD_ID, "--standalone"]);
    expect(resumed!.command.slice(0, 8)).toEqual(["opencode", "run", "--standalone", "--format", "json", "--auto", "--session", OLD_ID]);
    expect(resumed!.text.startsWith("Review changes since old-head.\n")).toBe(true);
    expect(read(sight)).toEqual({ session: "continued", last_head: "old-head", repoql_calls: 1 });
    expect(read(path)).toEqual({ session_id: OLD_ID, head: "new-head" });
  });

  it("starts a new session when opencode no longer holds the earlier one", async () => {
    writeJson(path, { session_id: OLD_ID, head: "old-head" });
    const runner = new FakeOpencode([{ code: 1, output: "Session not found" }, turn("ses_new")]);
    expect(await runSession(runner)).toBe(0);
    expect(runner.processes).toHaveLength(2);
    expect(runner.processes[1]!.command).not.toContain("--session");
    expect(read(sight)).toEqual({ session: "lost", last_head: "old-head", repoql_calls: 0 });
    expect(read(path).session_id).toBe("ses_new");
  });

  it("falls back to a new session when the resumed turn fails", async () => {
    writeJson(path, { session_id: OLD_ID, head: "old-head" });
    const failed: Behavior = { code: 1, events: [line("error", OLD_ID, { error: { type: "x", message: "boom" } })] };
    const runner = new FakeOpencode([{ code: 0 }, failed, turn("ses_new")]);
    expect(await runSession(runner)).toBe(0);
    expect(read(sight).session).toBe("lost");
    expect(read(path).session_id).toBe("ses_new");
  });

  it("starts fresh without asking about the earlier session", async () => {
    writeJson(path, { session_id: OLD_ID, head: "old-head" });
    const runner = new FakeOpencode([turn("ses_new")]);
    expect(await runSession(runner, ["--fresh"])).toBe(0);
    expect(runner.processes).toHaveLength(1);
    expect(read(sight)).toEqual({ session: "fresh", last_head: "old-head", repoql_calls: 0 });
  });

  it("keeps an answer that is not a record as text, and does not advance the head on an error", async () => {
    writeFileSync(record, "stale");
    const runner = new FakeOpencode([{ code: 0, events: [text("ses_new", "I could not finish."), line("error", "ses_new", { error: {} })] }]);
    expect(await runSession(runner)).toBe(0);
    expect(readFileSync(record, "utf8")).toBe("I could not finish.");
    expect(read(path)).toEqual({ session_id: "ses_new", head: null });
  });

  it("reads a record inside a code fence, and nothing that is not an object", () => {
    expect(recordFrom('```json\n{"verdict": "approve"}\n```')).toEqual({ verdict: "approve" });
    expect(recordFrom('  {"verdict": "approve"}\n')).toEqual({ verdict: "approve" });
    expect(recordFrom("[1, 2]")).toBeNull();
    expect(recordFrom("Here it is: {}")).toBeNull();
  });

  it("ignores a session id that is not an id", async () => {
    const runner = new FakeOpencode([turn("../../etc")]);
    expect(await runSession(runner)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("installs opencode 2 over a missing or older one, and needs a credential", async () => {
    let installed = false;
    const which = () => (installed ? "/bin/opencode" : null);
    const runner = new FakeOpencode([{ code: 0 }]);
    const original = runner.spawn;
    const spawning = ((command: string, args: string[], options: SpawnOptions) => {
      if (command === "npm") installed = true;
      return original(command, args, options);
    }) as unknown as Spawn;
    environ.ANTHROPIC_API_KEY = "k";
    const prepared = createOpencodeAdapter({ spawn: spawning, which, environ, emit: (m) => messages.push(m) });
    expect(await prepared.prepare()).toBe(0);
    expect(runner.processes[0]!.command).toEqual(["npm", "install", "--global", "@opencode/cli"]);

    const older = new FakeOpencode([{ output: "1.19.5\n" }, { code: 0 }]);
    expect(await createOpencodeAdapter({ spawn: older.spawn, which: () => "/bin/opencode", environ, emit: (m) => messages.push(m) }).prepare()).toBe(0);
    expect(older.processes.map((p) => p.command[0])).toEqual(["opencode", "npm"]);
    expect(messages).toContain("opencode 1.19.5 is older than 2; installing @opencode/cli.");
  });

  it("accepts a stored sign-in, and refuses with what to set when there is none", async () => {
    const current = (output: string) =>
      new FakeOpencode([{ output: "2.2.0\n" }, { output }]);
    const stored = current("anthropic  stored\n");
    expect(await adapter(stored).prepare()).toBe(0);
    expect(stored.processes[1]!.command).toEqual(["opencode", "auth", "list", "--standalone"]);
    expect(await adapter(current("No authenticated integrations\n")).prepare()).toBe(1);
    expect(messages.at(-1)).toContain("OPENCODE_API_KEY");
  });

  it("archives the session from opencode's database and the record", async () => {
    writeJson(path, { session_id: OLD_ID, head: "old-head" });
    const runner = new FakeOpencode([{ code: 0 }]);
    expect(await adapter(runner).archive("O/R", 3)).toBe(0);
    expect(runner.processes[0]!.command).toEqual(["opencode", "session", "delete", OLD_ID, "--standalone"]);
    expect(existsSync(path)).toBe(false);
    expect(await adapter(new FakeOpencode()).archive("O/R", 3)).toBe(0);
    expect(messages.at(-1)).toBe("No opencode review session to archive for O/R#3.");
  });

  it("keeps the review database and the records between reviews", () => {
    const data = join(directory, "data", "opencode");
    expect(adapter(new FakeOpencode()).stateDirs()).toEqual([join(data, "review"), join(data, "review-sessions")]);
    expect(childEnvironment(environ).OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});
