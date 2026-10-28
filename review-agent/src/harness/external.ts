/**
 * An adapter of the user's own: an executable that takes the adapter command line, `run`, `archive`, `state-dirs`
 * and `prepare`, and does the work itself.
 */

import { basename, extname } from "node:path";

import {
  type Adapter,
  type AdapterDeps,
  type RunArgs,
  collect,
  errorText,
  exited,
  runtime,
  started,
} from "./adapter.js";

const NODE = new Set([".js", ".mjs", ".cjs", ".ts"]);

/** The adapter's name: its file name without `_session` and the extension, safe for an artifact name. */
export function externalName(path: string): string {
  return basename(path)
    .replace(/_session\.[^.]*$/, "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]/g, "-");
}

/** The program and leading arguments that run the adapter file: Node runs `.ts` by stripping its types. */
export function interpreter(path: string): [string, string[]] {
  const extension = extname(path).toLowerCase();
  if (NODE.has(extension)) return [process.execPath, [path]];
  if (extension === ".py") return ["python3", [path]];
  return [path, []];
}

/** The `run` command line an adapter takes, with `--` and the agent arguments last. */
export function runArguments(args: RunArgs): string[] {
  const line = ["run", "--repo", args.repo, "--pr", String(args.pr), "--head", args.head, "--first", args.first,
    "--again", args.again, "--schema", args.schema, "--record", args.record, "--events", args.events,
    "--sight", args.sight];
  if (args.fresh) line.push("--fresh");
  if (args.model !== undefined) line.push("--model", args.model);
  if (args.rql !== undefined) line.push("--rql", args.rql);
  return [...line, "--", ...args.agentArgs];
}

export function createExternalAdapter(path: string, deps: AdapterDeps = {}): Adapter {
  const rt = runtime(deps, 0);
  const [program, leading] = interpreter(path);

  const call = async (args: string[]): Promise<number> => {
    try {
      // The adapter's own output belongs in the job log.
      const child = rt.spawn(program, [...leading, ...args], { cwd: rt.cwd(), env: rt.environ, stdio: "inherit" });
      await started(child);
      return await exited(child);
    } catch (error) {
      rt.emit(`::error::The adapter ${path} could not be started: ${errorText(error)}`);
      return 1;
    }
  };

  return {
    name: externalName(path),
    prepare: () => call(["prepare"]),
    async stateDirs() {
      const child = rt.spawn(program, [...leading, "state-dirs"], { cwd: rt.cwd(), env: rt.environ, stdio: ["ignore", "pipe", "inherit"] });
      await started(child);
      const out = collect(child.stdout);
      const [code] = await Promise.all([exited(child), out.done]);
      if (code !== 0) throw new Error(`The adapter ${path} exited ${code} from state-dirs.`);
      return out.text().split("\n").filter((line) => line.length > 0);
    },
    run: (args) => call(runArguments(args)),
    archive: (repo, pr) => call(["archive", "--repo", repo, "--pr", String(pr)]),
  };
}
