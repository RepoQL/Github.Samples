/** What every action step shares: running a command, reading the rql host's status, and naming an adapter. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Print the child's output to the job log as it runs, instead of capturing it. */
  inherit?: boolean;
}

/** Run a command to completion. A command that cannot start resolves with code 127, as a shell would. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", options.inherit ? "inherit" : "pipe", options.inherit ? "inherit" : "pipe"],
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: stderr + String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The pid on `Host: ... · pid N ...`, which a host reports about itself. */
export function servingPid(status: string): string {
  return /^Host:.* pid (\d+)/m.exec(status)?.[1] ?? "";
}

export function accountLine(status: string): string {
  return /^Account:.*$/m.exec(status)?.[0] ?? "";
}

/** Detail lines are printed under --all; an rql that predates it prints them by default. */
export async function hostStatus(rql: string, cwd: string): Promise<string> {
  const all = await run(rql, ["host", "status", "--all"], { cwd });
  if (all.code === 0) return all.stdout + all.stderr;
  const plain = await run(rql, ["host", "status"], { cwd });
  return plain.stdout + plain.stderr;
}

/** The name an adapter's artifacts and records are kept under. */
export function adapterName(agent: string): string {
  if (agent === "claude" || agent === "codex") return agent;
  const base = agent.split(/[\\/]/).pop() ?? agent;
  return base.replace(/_session\.[^.]*$/, "").replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]/g, "-");
}

/** The event that started the run, as GitHub wrote it to GITHUB_EVENT_PATH. */
export function eventPayload(environ: NodeJS.ProcessEnv = process.env): Record<string, any> {
  try {
    return JSON.parse(readFileSync(environ.GITHUB_EVENT_PATH ?? "", "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

export function runUrl(environ: NodeJS.ProcessEnv = process.env): string {
  return `${environ.GITHUB_SERVER_URL}/${environ.GITHUB_REPOSITORY}/actions/runs/${environ.GITHUB_RUN_ID}/attempts/${environ.GITHUB_RUN_ATTEMPT || "1"}`;
}

export function repository(environ: NodeJS.ProcessEnv = process.env): { owner: string; name: string; full: string } {
  const full = environ.GITHUB_REPOSITORY ?? "";
  const [owner = "", name = ""] = full.split("/");
  return { owner, name, full };
}
