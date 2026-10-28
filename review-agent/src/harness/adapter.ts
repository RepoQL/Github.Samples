/**
 * The harness adapter contract, and the command line every adapter takes.
 *
 * Every adapter takes the same `run`, `archive`, `state-dirs` and `prepare` commands, writes the record the harness
 * returned, and writes the sight file the gate and the renderer read.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";

import type { Io } from "../io.js";

export interface RunArgs {
  repo: string;
  pr: number;
  head: string;
  first: string;
  again: string;
  schema: string;
  record: string;
  events: string;
  sight: string;
  fresh: boolean;
  model?: string;
  rql?: string;
  /** What followed `--`. */
  agentArgs: string[];
}

export interface Adapter {
  /** "codex", "claude", or derived from an external adapter's file name. */
  name: string;
  prepare(): Promise<number>;
  /** The directories a runner must keep between reviews for a session to continue. */
  stateDirs(): string[] | Promise<string[]>;
  run(args: RunArgs): Promise<number>;
  archive(repo: string, pr: number): Promise<number>;
}

export type Spawn = typeof nodeSpawn;

/** Milliseconds: the compaction's whole budget, and the grace a stopped child has before it is killed. */
export interface Timeouts {
  compact?: number;
  stop?: number;
}

export interface AdapterDeps {
  spawn?: Spawn;
  which?: (name: string) => string | null;
  environ?: NodeJS.ProcessEnv;
  emit?: (line: string) => void;
  cwd?: string;
  timeouts?: Timeouts;
}

export interface Runtime {
  spawn: Spawn;
  which: (name: string) => string | null;
  environ: NodeJS.ProcessEnv;
  emit: (line: string) => void;
  cwd: () => string;
  timeouts: Required<Timeouts>;
}

export function runtime(deps: AdapterDeps, compact: number): Runtime {
  return {
    spawn: deps.spawn ?? nodeSpawn,
    which: deps.which ?? which,
    environ: deps.environ ?? process.env,
    emit: deps.emit ?? ((line) => console.log(line)),
    cwd: () => deps.cwd ?? process.cwd(),
    timeouts: { compact: deps.timeouts?.compact ?? compact, stop: deps.timeouts?.stop ?? 5000 },
  };
}

/** The executable `name` resolves to on PATH, or null. */
export function which(name: string): string | null {
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  const candidates = name.includes("/") ? [name] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, name));
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const file = candidate + extension;
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** A session record the adapter cannot continue from: Python's ValueError. */
export class SessionRecordError extends Error {}

export interface SessionRecord {
  session_id: string;
  head: string | null;
}

/** An operating-system failure, Python's OSError: a file or a process the system refused. */
export function isOsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" && "syscall" in error;
}

/** A value that could not be read as what it should be, Python's ValueError. */
export function isValueError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof SessionRecordError;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's `json.dumps` spelling, so records, sights and arguments are byte-for-byte what the Python adapters wrote. */
export function jsonDumps(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(value)) return "[" + value.map(jsonDumps).join(", ") + "]";
  if (isObject(value)) {
    return "{" + Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${jsonDumps(k)}: ${jsonDumps(v)}`).join(", ") + "}";
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  writeFileSync(temporary, jsonDumps(value) + "\n", "utf8");
  renameSync(temporary, path);
}

export function readSession(path: string): SessionRecord {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(value) || typeof value.session_id !== "string" || !value.session_id) {
    throw new SessionRecordError("Session record has no session_id");
  }
  // The id names a file to delete and an argument to the harness, so it is only ever an id.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.session_id)) {
    throw new SessionRecordError("Session record has an invalid session_id");
  }
  if (value.head !== undefined && value.head !== null && typeof value.head !== "string") {
    throw new SessionRecordError("Session record has an invalid head");
  }
  return { session_id: value.session_id, head: (value.head as string | null | undefined) ?? null };
}

export function sessionRecordPath(home: string, repo: string, pr: number): string {
  const slash = repo.indexOf("/");
  if (slash < 0) throw new Error(`The repository ${repo} is not owner/name`);
  return join(home, "review-sessions", repo.slice(0, slash), repo.slice(slash + 1), `${pr}.json`);
}

export function unlinkMissingOk(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Resolve once the child is running; reject with the system's error when it could not be started. */
export function started(child: ChildProcess): Promise<void> {
  // A child's later errors surface through its exit and its streams.
  child.on("error", () => {});
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** The child's exit status as Python reports it: its code, or the negated signal that ended it. */
export function exitCodeOf(child: ChildProcess): number {
  if (child.exitCode !== null) return child.exitCode;
  const signal = child.signalCode;
  return signal ? -(osConstants.signals[signal] ?? 1) : 1;
}

/** Whether the child exited within `ms`. */
export function waitExit(child: ChildProcess, ms = Infinity): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
    if (ms !== Infinity) {
      timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(!running(child));
      }, ms);
    }
  });
}

export async function exited(child: ChildProcess): Promise<number> {
  await waitExit(child);
  return exitCodeOf(child);
}

/** Python's universal newlines, which `text=True` gives a child's output. */
export function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Python's `str.splitlines`. */
export function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Call `onLine` with each line of the stream, its newline included, as Python's iteration of a text-mode pipe gives
 * them: chunks that split a line are joined, and a last line without a newline is still a line.
 */
export function forEachLine(stream: Readable, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let carriage = false;
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };
    const drain = () => {
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end + 1);
        buffered = buffered.slice(end + 1);
        onLine(line);
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (settled) return;
      try {
        let text = (carriage ? "\r" : "") + chunk;
        carriage = text.endsWith("\r");
        if (carriage) text = text.slice(0, -1);
        buffered += universalNewlines(text);
        drain();
      } catch (error) {
        settle(error);
        stream.destroy();
      }
    });
    stream.once("end", () => {
      if (settled) return;
      try {
        if (carriage) buffered += "\n";
        drain();
        if (buffered) onLine(buffered);
        settle();
      } catch (error) {
        settle(error);
      }
    });
    stream.once("error", (error) => settle(error));
    stream.once("close", () => settle());
  });
}

/** The whole of a stream, decoded with universal newlines. */
export function collect(stream: Readable | null): { done: Promise<void>; text: () => string } {
  let text = "";
  if (!stream) return { done: Promise.resolve(), text: () => text };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => (text += chunk));
  const done = new Promise<void>((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
    stream.once("error", () => resolve());
  });
  return { done, text: () => universalNewlines(text) };
}

/** Write the prompt to the child and close its input; a child that stops reading is not an error here. */
export function feedPrompt(child: ChildProcess, prompt: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on("error", () => {});
  stdin.end(prompt);
}

/** Run a command to completion with its output in the job log, as `subprocess.run(..., check=False)` does. */
export async function runCommand(
  rt: Runtime,
  command: string,
  args: string[],
  stdin: "inherit" | "ignore" | { input: string } = "inherit",
): Promise<number> {
  const child = rt.spawn(command, args, { cwd: rt.cwd(), stdio: [typeof stdin === "string" ? stdin : "pipe", "inherit", "inherit"] });
  await started(child);
  if (typeof stdin === "object") feedPrompt(child, stdin.input);
  return exited(child);
}

const RUN_OPTIONS = {
  repo: { type: "string" },
  pr: { type: "string" },
  head: { type: "string" },
  first: { type: "string" },
  again: { type: "string" },
  schema: { type: "string" },
  record: { type: "string" },
  events: { type: "string" },
  sight: { type: "string" },
  fresh: { type: "boolean" },
  model: { type: "string" },
  rql: { type: "string" },
} as const;

const ARCHIVE_OPTIONS = { repo: RUN_OPTIONS.repo, pr: RUN_OPTIONS.pr } as const;

const REQUIRED_RUN = ["repo", "pr", "head", "first", "again", "schema", "record", "events", "sight"] as const;

const USAGE = "usage: adapter {run,archive,state-dirs,prepare} ...";

class UsageError extends Error {}

function integer(value: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(value)) throw new UsageError(`argument --pr: invalid int value: '${value}'`);
  return Number.parseInt(value, 10);
}

function required(values: Record<string, unknown>, names: readonly string[]): void {
  const missing = names.filter((name) => values[name] === undefined).map((name) => "--" + name);
  if (missing.length) throw new UsageError(`the following arguments are required: ${missing.join(", ")}`);
}

/** Parse the adapter command line and call the adapter, as each Python adapter's `main` did. */
export async function adapterMain(adapter: Adapter, argv: string[], io: Io): Promise<number> {
  try {
    const [command, ...rest] = argv;
    const split = rest.indexOf("--");
    const own = split < 0 ? rest : rest.slice(0, split);
    const agentArgs = split < 0 ? [] : rest.slice(split + 1);
    if (command !== "run" && split >= 0) throw new UsageError(`unrecognized arguments: ${rest.slice(split).join(" ")}`);
    switch (command) {
      case "state-dirs":
      case "prepare": {
        parse(own, {});
        if (command === "prepare") return await adapter.prepare();
        for (const directory of await adapter.stateDirs()) io.emit(directory);
        return 0;
      }
      case "archive": {
        const values = parse(own, ARCHIVE_OPTIONS);
        required(values, ["repo", "pr"]);
        return await adapter.archive(values.repo as string, integer(values.pr as string));
      }
      case "run": {
        const values = parse(own, RUN_OPTIONS);
        required(values, REQUIRED_RUN);
        const args: RunArgs = {
          repo: values.repo as string,
          pr: integer(values.pr as string),
          head: values.head as string,
          first: values.first as string,
          again: values.again as string,
          schema: values.schema as string,
          record: values.record as string,
          events: values.events as string,
          sight: values.sight as string,
          fresh: values.fresh === true,
          agentArgs,
        };
        if (values.model !== undefined) args.model = values.model as string;
        if (values.rql !== undefined) args.rql = values.rql as string;
        return await adapter.run(args);
      }
      default:
        throw new UsageError(
          command === undefined
            ? "the following arguments are required: command"
            : `argument command: invalid choice: '${command}' (choose from 'run', 'archive', 'state-dirs', 'prepare')`,
        );
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.emit(USAGE);
    io.emit(`error: ${error.message}`);
    return 2;
  }
}

function parse(args: string[], options: Record<string, { type: "string" | "boolean" }>): Record<string, unknown> {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as Record<string, unknown>;
  } catch (error) {
    throw new UsageError(errorText(error));
  }
}
