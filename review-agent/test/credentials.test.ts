import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLAUDE, CODEX, OPENCODE, SECRET_NAMES, credentialValues } from "../src/credentials.js";
import { CREDENTIALS as CLAUDE_ACCEPTS } from "../src/harness/claude.js";
import { CREDENTIALS as OPENCODE_ACCEPTS } from "../src/harness/opencode.js";
import { redact, secretsOf } from "../src/job.js";

describe("the credential registry", () => {
  it("scrubs every credential any harness accepts", () => {
    const secrets = [...CLAUDE_ACCEPTS.filter((name) => !name.startsWith("CLAUDE_CODE_USE_")), ...CODEX, ...OPENCODE_ACCEPTS];
    for (const name of secrets) expect(SECRET_NAMES).toContain(name);
    expect(OPENCODE_ACCEPTS).toBe(OPENCODE);
  });

  it("redacts each named credential, and any the name pattern catches, from a review's files", () => {
    const directory = mkdtempSync(join(tmpdir(), "credentials-"));
    try {
      const environ: NodeJS.ProcessEnv = {};
      for (const [index, name] of [...SECRET_NAMES, "AWS_SECRET_ACCESS_KEY", "ACTIONS_RUNTIME_TOKEN", "MISTRAL_API_KEY"].entries()) {
        environ[name] = `secret-value-${String(index).padStart(3, "0")}`;
      }
      environ.CLAUDE_CODE_USE_BEDROCK = "1";
      environ.PUBLIC_URL = "plainly-public-value";
      const file = join(directory, "events.jsonl");
      writeFileSync(file, Object.values(environ).join("\n"));
      redact([file], secretsOf(environ));
      const left = readFileSync(file, "utf8");
      expect(left).not.toMatch(/secret-value-\d{3}/);
      expect(left).toContain("plainly-public-value");
      expect(left.split("\n")).toContain("1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads the value of every named credential even when it is unset", () => {
    expect(credentialValues({})).toHaveLength(SECRET_NAMES.length);
    expect(credentialValues({ FOO_TOKEN: "x" })).toContain("x");
  });
});
