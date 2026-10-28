/** Verify that an adapter of the user's own is run with the adapter command line, and that the command line parses. */

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { type Adapter, type RunArgs, type Spawn, adapterMain } from "../src/harness/adapter.js";
import { createExternalAdapter, externalName, interpreter } from "../src/harness/external.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("No real process");
  },
}));

interface Call {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** A child that prints `output` and exits with `code`, or fails to start with `error`. */
class FakeChild extends EventEmitter {
  readonly stdin = null;
  readonly stdout: PassThrough | null;
  readonly stderr = null;
  exitCode: number | null = null;
  signalCode = null;

  constructor(options: SpawnOptions, code: number, output: string, error?: Error) {
    super();
    const stdio = options.stdio;
    this.stdout = Array.isArray(stdio) && stdio[1] === "pipe" ? new PassThrough() : null;
    process.nextTick(() => {
      if (error) {
        this.exitCode = -2;
        this.emit("error", error);
        return;
      }
      this.emit("spawn");
      this.stdout?.end(output);
      this.exitCode = code;
      process.nextTick(() => {
        this.emit("exit", code, null);
        this.emit("close", code, null);
      });
    });
  }

  kill(): boolean {
    return false;
  }
}

function fake(code = 0, output = "", error?: Error): { calls: Call[]; spawn: Spawn } {
  const calls: Call[] = [];
  const spawn = ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    return new FakeChild(options, code, output, error);
  }) as unknown as Spawn;
  return { calls, spawn };
}

const RUN: RunArgs = {
  repo: "O/R",
  pr: 3,
  head: "sha",
  first: "first.md",
  again: "again.md",
  schema: "record.schema.json",
  record: "record.json",
  events: "events.jsonl",
  sight: "session.json",
  fresh: true,
  model: "m",
  rql: "/opt/rql",
  agentArgs: ["--max-turns", "9"],
};

const RUN_LINE = ["run", "--repo", "O/R", "--pr", "3", "--head", "sha", "--first", "first.md", "--again", "again.md",
  "--schema", "record.schema.json", "--record", "record.json", "--events", "events.jsonl", "--sight", "session.json",
  "--fresh", "--model", "m", "--rql", "/opt/rql", "--", "--max-turns", "9"];

describe("external adapter", () => {
  it("is named after its file without _session and the extension", () => {
    expect(externalName("/w/gemini_session.py")).toBe("gemini");
    expect(externalName("/w/gemini_session.ts")).toBe("gemini");
    expect(externalName("adapters/aider.mjs")).toBe("aider");
    expect(externalName("my agent!.sh")).toBe("my-agent-");
    expect(externalName("plain")).toBe("plain");
  });

  it("runs scripts with node or python3 and anything else directly", () => {
    for (const file of ["a.js", "a.mjs", "a.cjs", "a.ts"]) expect(interpreter(file)).toEqual([process.execPath, [file]]);
    expect(interpreter("a_session.py")).toEqual(["python3", ["a_session.py"]]);
    expect(interpreter("/bin/adapter")).toEqual(["/bin/adapter", []]);
  });

  it("passes run through in the command line shape with the agent arguments last", async () => {
    const { calls, spawn } = fake(7);
    const environ = { A: "1" };
    const adapter = createExternalAdapter("/w/my_session.ts", { spawn, environ, cwd: "/w" });
    expect(adapter.name).toBe("my");
    expect(await adapter.run(RUN)).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args).toEqual(["/w/my_session.ts", ...RUN_LINE]);
    expect(calls[0]!.options).toMatchObject({ cwd: "/w", env: environ, stdio: "inherit" });
  });

  it("leaves out the options a run was not given, but never the separator", async () => {
    const { calls, spawn } = fake();
    const { model: _model, rql: _rql, ...rest } = RUN;
    await createExternalAdapter("/w/agent", { spawn }).run({ ...rest, fresh: false, agentArgs: [] });
    expect(calls[0]!.command).toBe("/w/agent");
    expect(calls[0]!.args).toEqual([...RUN_LINE.slice(0, 19), "--"]);
  });

  it("prepare and archive return the adapter's exit code", async () => {
    const { calls, spawn } = fake(4);
    const adapter = createExternalAdapter("/w/a_session.py", { spawn });
    expect(await adapter.prepare()).toBe(4);
    expect(await adapter.archive("O/R", 3)).toBe(4);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["python3", "/w/a_session.py", "prepare"],
      ["python3", "/w/a_session.py", "archive", "--repo", "O/R", "--pr", "3"],
    ]);
    expect(calls.every((call) => call.options.stdio === "inherit")).toBe(true);
  });

  it("state dirs are the non-empty lines the adapter prints", async () => {
    const { calls, spawn } = fake(0, "/home/a/sessions\n\n/home/a/records\n");
    expect(await createExternalAdapter("/w/a.js", { spawn }).stateDirs()).toEqual(["/home/a/sessions", "/home/a/records"]);
    expect(calls[0]!.args).toEqual(["/w/a.js", "state-dirs"]);
    expect(calls[0]!.options.stdio).toEqual(["ignore", "pipe", "inherit"]);
  });

  it("state dirs from a failing adapter are an error", async () => {
    const { spawn } = fake(3, "/partial\n");
    await expect(createExternalAdapter("/w/a.js", { spawn }).stateDirs()).rejects.toThrow("exited 3");
  });

  it("an adapter that cannot start fails with an actionable error", async () => {
    const error = Object.assign(new Error("spawn /w/agent EACCES"), { code: "EACCES", syscall: "spawn /w/agent" });
    const messages: string[] = [];
    const { spawn } = fake(0, "", error);
    expect(await createExternalAdapter("/w/agent", { spawn, emit: (line) => messages.push(line) }).prepare()).toBe(1);
    expect(messages).toEqual(["::error::The adapter /w/agent could not be started: spawn /w/agent EACCES"]);
  });
});

describe("adapter command line", () => {
  function recording(): { adapter: Adapter; seen: unknown[] } {
    const seen: unknown[] = [];
    return {
      seen,
      adapter: {
        name: "test",
        prepare: async () => (seen.push("prepare"), 5),
        stateDirs: async () => ["/a", "/b"],
        run: async (args) => (seen.push(args), 6),
        archive: async (repo, pr) => (seen.push([repo, pr]), 0),
      },
    };
  }

  it("parses run, everything after -- belonging to the agent", async () => {
    const { adapter, seen } = recording();
    expect(await adapterMain(adapter, [...RUN_LINE.slice(0, -2), "-m", "--", "x"], { emit: () => {}, environ: {} })).toBe(6);
    expect(seen).toEqual([{ ...RUN, agentArgs: ["-m", "--", "x"] }]);
  });

  it("parses archive, state-dirs and prepare", async () => {
    const { adapter, seen } = recording();
    const lines: string[] = [];
    const io = { emit: (line: string) => lines.push(line), environ: {} };
    expect(await adapterMain(adapter, ["archive", "--repo", "O/R", "--pr", "3"], io)).toBe(0);
    expect(await adapterMain(adapter, ["prepare"], io)).toBe(5);
    expect(await adapterMain(adapter, ["state-dirs"], io)).toBe(0);
    expect(seen).toEqual([["O/R", 3], "prepare"]);
    expect(lines).toEqual(["/a", "/b"]);
  });

  it("refuses a bad command line with exit 2 as argparse does", async () => {
    const { adapter, seen } = recording();
    const lines: string[] = [];
    const io = { emit: (line: string) => lines.push(line), environ: {} };
    expect(await adapterMain(adapter, ["run", "--repo", "O/R"], io)).toBe(2);
    expect(lines.at(-1)).toContain("the following arguments are required: --pr, --head");
    expect(await adapterMain(adapter, ["archive", "--repo", "O/R", "--pr", "three"], io)).toBe(2);
    expect(lines.at(-1)).toContain("invalid int value: 'three'");
    expect(await adapterMain(adapter, ["review"], io)).toBe(2);
    expect(await adapterMain(adapter, [], io)).toBe(2);
    expect(await adapterMain(adapter, ["prepare", "--unknown"], io)).toBe(2);
    expect(seen).toEqual([]);
  });
});
