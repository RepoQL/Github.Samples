import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutApproval } from "../src/actions/publish.js";
import { servedCount } from "../src/actions/review.js";
import { watchedPid } from "../src/actions/setup.js";
import { repoqlCalls } from "../src/job.js";

describe("the options a workflow sets", () => {
  it("reads the pid rql watch reports for the host it started", () => {
    expect(watchedPid("[rql watch] run: 42\n[rql watch] pid: 9122\nHost starting\n")).toBe(9122);
    expect(watchedPid("Host starting\n")).toBe(0);
    expect(watchedPid("note [rql watch] pid: 5")).toBe(0);
  });

  it("reads the served-request count from rql query's JSON lines, never from the rendered footer", () => {
    expect(servedCount('{"served":8}\n')).toBe(8);
    expect(servedCount('{"served":0}')).toBe(0);
    // What the rendered form printed on a real observer: the footer is the last line.
    expect(servedCount("served\n8\n[4 tok | 15 ms]\n")).toBe(0);
    expect(servedCount("Error: no watch schema\n")).toBe(0);
    expect(servedCount('{"served":"8"}')).toBe(0);
    expect(servedCount("")).toBe(0);
  });

  it("posts an approval as a comment for an advisory reviewer, and leaves every other verdict alone", () => {
    const plan = { event: "APPROVE", body: "LGTM", status: { state: "success" } };
    expect(withoutApproval(plan)).toEqual({ ...plan, event: "COMMENT" });
    expect(plan.event).toBe("APPROVE");
    for (const event of ["REQUEST_CHANGES", "COMMENT"]) expect(withoutApproval({ ...plan, event }).event).toBe(event);
  });

  it("counts the repoql calls the adapter recorded, and none from a sight it cannot read", () => {
    const directory = mkdtempSync(join(tmpdir(), "options-"));
    try {
      const sight = join(directory, "session.json");
      writeFileSync(sight, JSON.stringify({ session: "new", repoql_calls: 4 }));
      expect(repoqlCalls(sight)).toBe(4);
      writeFileSync(sight, "not json");
      expect(repoqlCalls(sight)).toBe(0);
      expect(repoqlCalls(join(directory, "missing.json"))).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
