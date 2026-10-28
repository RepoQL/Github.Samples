/** Verify that each adapter installs its harness when missing and refuses to run without a credential. */

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Spawn } from "../src/harness/adapter.js";
import { CREDENTIALS, createClaudeAdapter } from "../src/harness/claude.js";
import { createCodexAdapter } from "../src/harness/codex.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("No real process");
  },
}));

/** A command that reads its input, if it was given a pipe, then exits with its code. */
class Completed extends EventEmitter {
  readonly stdin: PassThrough | null;
  readonly stdout = null;
  readonly stderr = null;
  exitCode: number | null = null;
  signalCode = null;

  constructor(options: SpawnOptions, code: number, onInput: (input: string) => void) {
    super();
    const stdio = options.stdio;
    this.stdin = Array.isArray(stdio) && stdio[0] === "pipe" ? new PassThrough() : null;
    process.nextTick(() => this.emit("spawn"));
    const finish = () => {
      this.exitCode = code;
      process.nextTick(() => {
        this.emit("exit", code, null);
        this.emit("close", code, null);
      });
    };
    if (this.stdin) {
      let input = "";
      this.stdin.setEncoding("utf8");
      this.stdin.on("data", (chunk: string) => (input += chunk));
      this.stdin.on("end", () => {
        onInput(input);
        finish();
      });
    } else {
      finish();
    }
  }

  kill(): boolean {
    return false;
  }
}

/** Answer each command with the code configured for its first words. */
class Runner {
  readonly calls: [string[], string | null][] = [];

  constructor(
    readonly codes: Record<string, number> = {},
    readonly installs?: Set<string>,
  ) {}

  readonly spawn = ((command: string, args: string[], options: SpawnOptions) => {
    const words = [command, ...args];
    const call: [string[], string | null] = [words, null];
    this.calls.push(call);
    if (command === "npm" && args[0] === "install" && this.installs) this.installs.add(words.at(-1)!);
    return new Completed(options, this.codes[words.slice(0, 3).join(" ")] ?? 0, (input) => (call[1] = input));
  }) as unknown as Spawn;
}

function whichFor(installed: Set<string>): (name: string) => string | null {
  const names: Record<string, string> = { "@openai/codex": "codex", "@anthropic-ai/claude-code": "claude" };
  return (name) => (installed.has(name) || [...installed].some((i) => names[i] === name) ? `/bin/${name}` : null);
}

describe("prepare", () => {
  let home: string;
  let messages: string[];
  const emit = (line: string) => messages.push(line);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "prepare-"));
    messages = [];
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("codex is installed then signed in from the api key", async () => {
    const installed = new Set<string>();
    const runner = new Runner({ "codex login status": 1 }, installed);
    const environ = { CODEX_HOME: home, OPENAI_API_KEY: "sk-key" };
    expect(await createCodexAdapter({ spawn: runner.spawn, environ, emit, which: whichFor(installed) }).prepare()).toBe(0);
    expect(runner.calls).toEqual([
      [["npm", "install", "--global", "@openai/codex"], null],
      [["codex", "login", "status"], null],
      [["codex", "login", "--with-api-key"], "sk-key"],
    ]);
  });

  it("codex already signed in needs no key", async () => {
    const runner = new Runner();
    expect(await createCodexAdapter({ spawn: runner.spawn, environ: {}, emit, which: whichFor(new Set(["codex"])) }).prepare()).toBe(0);
    expect(runner.calls).toEqual([[["codex", "login", "status"], null]]);
  });

  it("codex without a sign in or key says how to give one", async () => {
    const runner = new Runner({ "codex login status": 1 });
    expect(await createCodexAdapter({ spawn: runner.spawn, environ: {}, emit, which: whichFor(new Set(["codex"])) }).prepare()).toBe(1);
    expect(messages.at(-1)).toContain("OPENAI_API_KEY");
  });

  it("a failed install is an error", async () => {
    const runner = new Runner({ "npm install --global": 1 });
    const deps = { spawn: runner.spawn, environ: {}, emit, which: whichFor(new Set()) };
    expect(await createCodexAdapter(deps).prepare()).toBe(1);
    expect(await createClaudeAdapter(deps).prepare()).toBe(1);
    expect(messages.every((message) => message.startsWith("Installing") || message.startsWith("::error::"))).toBe(true);
  });

  it("claude needs one unattended credential", async () => {
    const environ = { CLAUDE_CONFIG_DIR: home };
    const which = whichFor(new Set(["claude"]));
    expect(await createClaudeAdapter({ spawn: new Runner().spawn, environ, emit, which }).prepare()).toBe(1);
    expect(messages.at(-1)).toContain("ANTHROPIC_API_KEY");
    for (const name of CREDENTIALS) {
      expect(await createClaudeAdapter({ spawn: new Runner().spawn, environ: { ...environ, [name]: "1" }, emit, which }).prepare()).toBe(0);
    }
    writeFileSync(join(home, ".credentials.json"), "{}");
    expect(await createClaudeAdapter({ spawn: new Runner().spawn, environ, emit, which }).prepare()).toBe(0);
  });

  it("claude is installed when missing", async () => {
    const installed = new Set<string>();
    const runner = new Runner({}, installed);
    const adapter = createClaudeAdapter({ spawn: runner.spawn, environ: { ANTHROPIC_API_KEY: "k" }, emit, which: whichFor(installed) });
    expect(await adapter.prepare()).toBe(0);
    expect(runner.calls).toEqual([[["npm", "install", "--global", "@anthropic-ai/claude-code"], null]]);
  });
});
