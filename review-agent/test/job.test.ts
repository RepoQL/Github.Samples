import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as job from "../src/job.js";

const PACK = join(import.meta.dirname, "..");

describe("the review action's own steps", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "review-job-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function writeSight(value: object): string {
    const path = join(directory, "session.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it("fills every placeholder of the shipped prompts but the adapter's", () => {
    const out = join(directory, "prompts");
    job.prompts(join(PACK, "prompts"), out, {
      pr: "7", repo: "O/R", title: 'Fix "it"', base_ref: "main", head_sha: "abc", kata: "/k",
      brief: "/b.md", scratch: "/s", instructions: "Run make test.",
    });
    const first = readFileSync(join(out, "first.md"), "utf8");
    const again = readFileSync(join(out, "again.md"), "utf8");
    expect(first.startsWith('You are the reviewer of pull request #7 in O/R: "Fix "it"".')).toBe(true);
    for (const text of [first, again]) {
      expect(text).not.toContain("{{");
      expect(text).toContain("/k/SKILL.md");
      expect(text).toContain("/b.md");
      expect(text).toContain("Run make test.");
    }
    expect(again).toContain("The last review you completed was of {last_head}.");
    expect(first).not.toContain("{last_head}");
  });

  it("ends the environment cleanly without instructions", () => {
    const out = join(directory, "prompts");
    job.prompts(join(PACK, "prompts"), out, { kata: "/k" });
    expect(readFileSync(join(out, "first.md"), "utf8").endsWith("publishes it.\n")).toBe(true);
  });

  it("needs a repoql call for a first review", () => {
    expect(job.gate(writeSight({ session: "new", repoql_calls: 3 }))).toEqual({ ok: true, impaired: null });
    for (const session of ["new", "fresh", "lost"]) {
      expect(job.gate(writeSight({ session, repoql_calls: 0 }))).toEqual({ ok: false, impaired: null });
    }
    expect(job.gate(writeSight({ session: "new" }))).toEqual({ ok: false, impaired: null });
    expect(job.gate(join(directory, "missing.json"))).toEqual({ ok: false, impaired: null });
  });

  it("publishes a re-review without repoql as impaired", () => {
    expect(job.gate(writeSight({ session: "continued", repoql_calls: 0 }))).toEqual({
      ok: true,
      impaired: job.NO_REPOQL_ON_RE_REVIEW,
    });
  });

  it("carries the session and only real impairments in the sight", () => {
    expect(job.sight(writeSight({ session: "lost" }), "1.2.3", "opus", "https://run", "/review", ["", "No RepoQL."])).toEqual({
      session: "lost", rql: "1.2.3", model: "opus", run_url: "https://run", command: "/review", impaired: ["No RepoQL."],
    });
    expect(job.sight(join(directory, "missing.json"), "r", "m", "u", "/review", []).session).toBe("new");
  });

  it("redacts known credentials and extra ones", () => {
    const folder = join(directory, "review");
    mkdirSync(folder);
    writeFileSync(join(folder, "events.jsonl"), "token ghs_aaaaaaaaaaaa and sk-ant-bbbbbbbbbb and short\n");
    writeFileSync(join(folder, "plan.json"), "custom-secret-value\n");
    const log = join(directory, "host.log");
    writeFileSync(log, "nothing here\n");
    const environ = { GH_TOKEN: "ghs_aaaaaaaaaaaa", ANTHROPIC_API_KEY: "sk-ant-bbbbbbbbbb", OPENAI_API_KEY: "short" };
    const hits = job.redact([folder, log, join(directory, "absent")], job.secretsOf(environ, "custom-secret-value\n"));
    expect(hits).toBe(3);
    expect(readFileSync(join(folder, "events.jsonl"), "utf8")).toBe("token [REDACTED] and [REDACTED] and short\n");
    expect(readFileSync(join(folder, "plan.json"), "utf8")).toBe("[REDACTED]\n");
    expect(readFileSync(log, "utf8")).toBe("nothing here\n");
  });

  it("masks a secret in a binary file at its own length, so the file's structure survives", () => {
    const file = join(directory, "opencode.db");
    const secret = "sk-ant-dddddddddd";
    const bytes = Buffer.concat([Buffer.from([0x53, 0x51, 0x00, 0xff, 0x01]), Buffer.from(`x${secret}y`), Buffer.from([0x00, 0xfe])]);
    writeFileSync(file, bytes);
    expect(job.redact([file], [secret])).toBe(1);
    const after = readFileSync(file);
    expect(after.length).toBe(bytes.length);
    expect(after.includes(Buffer.from(secret))).toBe(false);
    expect([...after.subarray(0, 5)]).toEqual([0x53, 0x51, 0x00, 0xff, 0x01]);
    expect(after.subarray(5).toString("latin1")).toBe(`x${"*".repeat(secret.length)}y\u0000þ`);
  });

  it("replaces a secret that contains another whole", () => {
    const file = join(directory, "events.jsonl");
    writeFileSync(file, "sk-ant-cccccccccc-longer");
    expect(job.redact([file], ["sk-ant-cccccccccc", "sk-ant-cccccccccc-longer"])).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("[REDACTED]");
  });

  it("opens a decision only from a trailing decision marker", () => {
    expect(job.opensDecision("Should it renew?\n\n<!-- review:decision expired-link -->\n")).toBe(true);
    expect(job.opensDecision("A defect.\n<!-- review:finding floor -->")).toBe(false);
    expect(job.opensDecision("Quoted: `<!-- review:decision x -->` in a proof.\n\nDone.")).toBe(false);
    expect(job.opensDecision("")).toBe(false);
  });

  it("scrubs session state before packing it and restores it only inside its directories", () => {
    const root = join(directory, "root");
    const sessions = join(root, "home", "sessions");
    mkdirSync(join(sessions, "2026"), { recursive: true });
    writeFileSync(join(sessions, "2026", "turn.jsonl"), '{"result": "token sk-ant-cccccccccc"}\n');
    const absent = join(root, "home", "review-sessions");
    const archive = join(directory, "out", "session.json.gz");
    expect(job.packState(archive, [sessions, absent], ["sk-ant-cccccccccc"], root)).toBe(1);
    rmSync(join(sessions, "2026"), { recursive: true });
    expect(job.unpackState(archive, [sessions, absent], root)).toBe(1);
    expect(readFileSync(join(sessions, "2026", "turn.jsonl"), "utf8")).toBe('{"result": "token [REDACTED]"}\n');
  });

  it("ignores entries outside the session directories when unpacking", () => {
    const root = join(directory, "root");
    const hostile = join(directory, "hostile.json.gz");
    const file = (path: string) => ({ path, mode: 0o644, content: Buffer.from("x").toString("base64") });
    writeFileSync(hostile, gzipSync(JSON.stringify({
      version: 1,
      files: [
        file("home/sessions/ok.jsonl"),
        file("home/.bashrc"),
        file("home/sessions/../.profile"),
        file("/etc/passwd"),
        file("home/sessions"),
        file("home/sessionsevil/x"),
        file("home/sessions//x"),
      ],
    })));
    expect(job.unpackState(hostile, [join(root, "home", "sessions")], root)).toBe(1);
    expect(existsSync(join(root, "home", "sessions", "ok.jsonl"))).toBe(true);
    for (const path of ["home/.bashrc", "home/.profile", "home/sessionsevil/x", "etc/passwd"]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });
});
