/**
 * Compose the reviewer's prompts, gate its use of RepoQL, state its sight, and redact what leaves the runner.
 *
 * The review action's own steps, which know neither the harness nor GitHub.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { trailingMarkers } from "./render.js";

/** The credentials a reviewer may hold, by the names the harnesses and rql read them from. */
export const SECRET_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "REPOQL_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

export function fill(template: string, values: Record<string, string>): string {
  for (const [name, value] of Object.entries(values)) template = template.split(`{{${name}}}`).join(value);
  return template;
}

/** Write first.md and again.md; `{last_head}` is left for the adapter. */
export function prompts(templates: string, out: string, given: Record<string, string>): void {
  const values = { ...given };
  const instructions = (values.instructions ?? "").trim();
  values.instructions = instructions ? `\n${instructions}\n` : "";
  values.environment = fill(readFileSync(join(templates, "environment.md"), "utf8"), values).trimEnd();
  mkdirSync(out, { recursive: true });
  for (const name of ["first.md", "again.md"]) {
    writeFileSync(join(out, name), fill(readFileSync(join(templates, name), "utf8"), values), "utf8");
  }
}

export interface SessionSight {
  session?: string;
  last_head?: string | null;
  repoql_calls?: number;
}

function readSessionSight(path: string): SessionSight | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as SessionSight) : null;
  } catch {
    return null;
  }
}

export const NO_REPOQL_ON_RE_REVIEW =
  "The reviewer made no RepoQL call in this review, so it rests on what the reviewer already knew and on plain file reads.";

/** A first review without RepoQL is no review; a re-review without it is published and says so. */
export function gate(sessionSight: string): { ok: boolean; impaired: string | null } {
  const sight = readSessionSight(sessionSight);
  if (!sight) return { ok: false, impaired: null };
  const calls = sight.repoql_calls;
  if (typeof calls === "number" && Number.isInteger(calls) && calls > 0) return { ok: true, impaired: null };
  if (sight.session === "continued") return { ok: true, impaired: NO_REPOQL_ON_RE_REVIEW };
  return { ok: false, impaired: null };
}

export interface Sight {
  session: string;
  rql: string;
  model: string;
  run_url: string;
  command: string;
  impaired: string[];
}

export function sight(sessionSight: string, rql: string, model: string, runUrl: string, command: string, impaired: string[]): Sight {
  const session = readSessionSight(sessionSight)?.session ?? "new";
  return { session, rql, model, run_url: runUrl, command, impaired: impaired.filter((text) => text) };
}

/** Whether a thread's first comment is a decision the reviewer opened, read only from its trailing markers. */
export function opensDecision(text: string): boolean {
  return trailingMarkers(text).some(([kind]) => kind === "decision");
}

function filesUnder(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => filesUnder(join(path, name)));
}

/** Replace every secret in the files under paths; return how many occurrences were replaced. */
export function redact(paths: string[], secrets: string[]): number {
  // Longest first, so a secret that contains another is replaced whole.
  const usable = [...new Set(secrets.filter((secret) => secret && secret.length >= 8))].sort((a, b) => b.length - a.length);
  if (!usable.length) return 0;
  let replaced = 0;
  for (const file of paths.flatMap(filesUnder)) {
    let text = readFileSync(file, "utf8");
    let hits = 0;
    for (const secret of usable) {
      const parts = text.split(secret);
      hits += parts.length - 1;
      text = parts.join("[REDACTED]");
    }
    if (hits) {
      writeFileSync(file, text, "utf8");
      replaced += hits;
    }
  }
  return replaced;
}

export function secretsOf(environ: NodeJS.ProcessEnv, extra = ""): string[] {
  return [...SECRET_NAMES.map((name) => environ[name] ?? ""), ...extra.split(/\r?\n/)].map((secret) => secret.trim());
}

interface PackedFile {
  path: string;
  mode: number;
  content: string;
}

/**
 * Write the session's directories to one gzipped manifest, after scrubbing them; return how many secrets were scrubbed.
 * Paths are stored relative to root. The format holds regular files only, so nothing it restores can be a link.
 */
export function packState(out: string, directories: string[], secrets: string[], root = "/"): number {
  const present = directories.filter((directory) => existsSync(directory));
  const hits = redact(present, secrets);
  const files: PackedFile[] = present.flatMap(filesUnder).map((file) => ({
    path: relative(root, file).split(sep).join("/"),
    mode: lstatSync(file).mode & 0o777,
    content: readFileSync(file).toString("base64"),
  }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gzipSync(JSON.stringify({ version: 1, files })));
  return hits;
}

/** Restore only the files that lie inside the session's directories; return how many were restored. */
export function unpackState(archive: string, directories: string[], root = "/"): number {
  const allowed = directories.map((directory) => relative(root, directory).split(sep).join("/"));
  const manifest = JSON.parse(gunzipSync(readFileSync(archive)).toString("utf8")) as { files?: PackedFile[] };
  let restored = 0;
  for (const file of manifest.files ?? []) {
    const name = typeof file.path === "string" ? file.path : "";
    const parts = name.split("/");
    const inside = allowed.some((prefix) => name.startsWith(`${prefix}/`));
    if (!inside || isAbsolute(name) || parts.includes("..") || parts.includes("") || typeof file.content !== "string") continue;
    const target = join(root, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.content, "base64"), { mode: (file.mode ?? 0o600) & 0o777 });
    restored += 1;
  }
  return restored;
}
