import { describe, expect, it } from "vitest";

import { accountLine, adapterName, runUrl, servingPid } from "../src/actions/common.js";

const STATUS = `Host: 1.7.15 (341f87a8) · pid 9122 · up 16s
Account: someone@example.com · org_01 · login session (user) · expires in 6m
Gates: queryable=true, searchable=true, ready=true`;

describe("the actions' helpers", () => {
  it("reads the serving host's pid and account from host status", () => {
    expect(servingPid(STATUS)).toBe("9122");
    expect(accountLine(STATUS)).toBe("Account: someone@example.com · org_01 · login session (user) · expires in 6m");
    expect(servingPid("No host is running.")).toBe("");
    expect(accountLine("Host: x · pid 1")).toBe("");
  });

  it("names an adapter by its file, as its artifacts are kept", () => {
    expect(adapterName("claude")).toBe("claude");
    expect(adapterName("codex")).toBe("codex");
    expect(adapterName("tools/gemini_session.py")).toBe("gemini");
    expect(adapterName("./tools/my agent.ts")).toBe("my-agent");
    expect(adapterName("bin/aider")).toBe("aider");
  });

  it("links the run's attempt", () => {
    expect(runUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "O/R", GITHUB_RUN_ID: "5", GITHUB_RUN_ATTEMPT: "2" }))
      .toBe("https://github.com/O/R/actions/runs/5/attempts/2");
    expect(runUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "O/R", GITHUB_RUN_ID: "5" }))
      .toBe("https://github.com/O/R/actions/runs/5/attempts/1");
  });
});
