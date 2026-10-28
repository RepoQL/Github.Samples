/**
 * The pack's one entry point, bundled to dist/index.js. Each action's main.js calls runAction with its name; run as a
 * program, it is the CLI a workflow or a person calls: `node dist/index.js <command> ...`.
 */

import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import * as core from "@actions/core";

import { archive, publish, reply } from "./actions/publish.js";
import { review } from "./actions/review.js";
import { setup, setupPost } from "./actions/setup.js";
import { githubFromEnvironment } from "./github-client.js";
import { adapterMain } from "./harness/adapter.js";
import { createClaudeAdapter } from "./harness/claude.js";
import { createCodexAdapter } from "./harness/codex.js";
import { createOpencodeAdapter } from "./harness/opencode.js";
import type { Io } from "./io.js";
import { redact, secretsOf } from "./job.js";
import { main as pullRequestMain } from "./pull-request.js";
import { main as renderMain } from "./render.js";

const ACTIONS: Record<string, () => Promise<void>> = {
  setup: () => setup(),
  "setup-post": () => setupPost(),
  review: () => review(),
  publish: () => publish(),
  reply: () => reply(),
  archive: () => archive(),
};

export async function runAction(name: string): Promise<void> {
  const action = ACTIONS[name];
  if (!action) return core.setFailed(`There is no action named ${name}.`);
  try {
    await action();
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

const USAGE = `usage: review-agent <command> [arguments]

  codex  <run|archive|state-dirs|prepare> ...   the Codex harness adapter
  claude <run|archive|state-dirs|prepare> ...   the Claude Code harness adapter
  opencode <run|archive|state-dirs|prepare> ... the opencode 2 harness adapter
  gather  --repo O/R --pr N --out context.json --brief pull-request.md
  publish --repo O/R --pr N --plan plan.json [--dry-run]
  render  --context context.json --sight sight.json (--record record.json | --raw text) (--out plan.json | --markdown)
  redact  <file or directory>... [--extra "more secrets, one per line"]
          scrubs the agent, rql and GitHub credentials in the environment from the files

GitHub calls use GH_TOKEN or GITHUB_TOKEN, and GITHUB_API_URL when it is set.`;

export async function cli(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "codex":
      return adapterMain(createCodexAdapter({ environ: io.environ, emit: io.emit }), rest, io);
    case "claude":
      return adapterMain(createClaudeAdapter({ environ: io.environ, emit: io.emit }), rest, io);
    case "opencode":
      return adapterMain(createOpencodeAdapter({ environ: io.environ, emit: io.emit }), rest, io);
    case "gather":
    case "publish":
      return pullRequestMain(argv, { ...io, github: githubFromEnvironment(io.environ) });
    case "render":
      return renderMain(rest, io);
    case "redact": {
      const { values, positionals } = parseArgs({ args: rest, options: { extra: { type: "string", default: "" } }, allowPositionals: true });
      if (!positionals.length) {
        io.emit("redact needs at least one file or directory.");
        return 2;
      }
      const hits = redact(positionals, secretsOf(io.environ, values.extra));
      if (hits) io.emit(`::warning::Redacted ${hits} credential occurrence(s) from ${positionals.length} path(s).`);
      return 0;
    }
    default:
      io.emit(command && command !== "--help" && command !== "-h" ? `Unknown command: ${command}\n\n${USAGE}` : USAGE);
      return command && command !== "--help" && command !== "-h" ? 2 : 0;
  }
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const io: Io = { emit: (line) => process.stdout.write(`${line}\n`), environ: process.env };
  cli(process.argv.slice(2), io).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
