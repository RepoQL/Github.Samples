// Verify review rendering against the handoff's text and routing contracts.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as render from "../src/render.js";
import type { Context, Plan, Sight, Thread } from "../src/render.js";

const ROOT = join(import.meta.dirname, "..");

type Json = Record<string, unknown>;

function fixture<T = Json>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, "fixtures", name), "utf8")) as T;
}

function record(changes: Json = {}): Json {
  return { ...fixture("record.json"), ...changes };
}

function finding(changes: Json = {}): Json {
  return {
    id: "budget", state: "open", blocks: true, asked: "works", how: "demonstrated", path: "src/A.cs", start_line: null, line: 43,
    point: "The budget is exceeded.", body: "The caller cannot bound the read.", suggestion: "return budget;",
    proof: "Run the budget test.", rests_on: [], reply: null, ...changes,
  };
}

function decision(changes: Json = {}): Json {
  return {
    id: "limit", state: "open", path: "src/A.cs", line: 42, question: "Which limit should apply?",
    context: "The default affects all callers.", options: [{ answer: "Small", leads_to: "Fewer results." }], answer: null,
    reply: null, ...changes,
  };
}

function thread(kind = "finding", id = "budget", changes: Json = {}): Thread {
  return {
    node_id: "PRRT_" + id, resolved: false, path: "src/A.cs", line: 43, kind, id, states: [], root_comment_id: 123456,
    comments: [{ author: "author", association: "OWNER", is_reviewer: false, body: "I changed it.", created_at: "now" }],
    ...changes,
  } as Thread;
}

function lines(text: string): string[] {
  return text.split("\n");
}

describe("RenderTests", () => {
  let context: Context;
  let sight: Sight;

  beforeEach(() => {
    context = fixture<Context>("context.json");
    sight = fixture<Sight>("sight.json");
  });

  function plan(changes: Json = {}): Plan {
    return render.render(record(changes), context, sight);
  }

  it("verdict frames and statuses", () => {
    const cases: [string, string, string, string, string[]][] = [
      ["approve", "APPROVE", "success", "Nothing should hold this", ["<details><summary>LGTM :shipit:</summary>", ""]],
      ["request_changes", "REQUEST_CHANGES", "failure", "Changes requested", ["> [!WARNING]", "> **Changes requested.** Headline."]],
      ["needs_decision", "COMMENT", "pending", "Waiting on a decision from a person", ["> [!IMPORTANT]", "> **A decision for a person.** Headline."]],
      ["undetermined", "COMMENT", "failure", "Could not establish whether this is correct", ["> [!CAUTION]", "> **Could not establish whether this change is correct.** Headline."]],
    ];
    for (const [verdict, event, state, description, first] of cases) {
      const result = plan({ verdict, headline: "Headline." });
      expect(result.event, verdict).toBe(event);
      expect(result.status, verdict).toEqual({ state, context: "review/verdict", description });
      expect(lines(result.body).slice(0, 2), verdict).toEqual(first);
      if (verdict === "approve") {
        expect(result.body).not.toContain("[!");
        expect(result.body).not.toContain("Headline.");
      }
    }
  });

  it("empty headline has no trailing space", () => {
    for (const [verdict, lead] of [
      ["request_changes", "Changes requested."],
      ["needs_decision", "A decision for a person."],
      ["undetermined", "Could not establish whether this change is correct."],
    ]) {
      expect(lines(plan({ verdict, headline: " \n " }).body)[1]).toBe(`> **${lead}**`);
    }
  });

  it("effective verdict and block counts", () => {
    for (const count of [1, 2]) {
      const result = plan({ findings: Array.from({ length: count }, (_, i) => finding({ id: String(i) })) });
      expect(result.verdict).toBe("request_changes");
      expect(result.status.description).toBe(count === 1 ? "1 finding blocks" : "2 findings block");
      expect(result.body).toContain("verdict stated as approve, published as request_changes</sub>");
    }
    expect(plan({ decisions: [decision()] }).verdict).toBe("needs_decision");
    expect(plan({ verdict: "undetermined", findings: [finding()] }).verdict).toBe("undetermined");
    expect(plan({ verdict: "request_changes", decisions: [decision()] }).verdict).toBe("request_changes");
    expect(plan({ findings: [finding({ state: "fixed" })] }).verdict).toBe("approve");
  });

  it("finding inline exact template", () => {
    const result = plan({ findings: [finding({ path: "./src/A.cs", start_line: 41 })] });
    expect(result.comments).toEqual([
      {
        path: "src/A.cs", line: 43, start_line: 41, side: "RIGHT", start_side: "RIGHT",
        body:
          "> [!WARNING]\n> The budget is exceeded.\n\n" +
          "The caller cannot bound the read.\n\n```suggestion\nreturn budget;\n```\n\n" +
          "<details><summary>Proof</summary>\n\nRun the budget test.\n\n</details>\n\n" +
          "<!-- review:finding budget -->",
      },
    ]);
    expect(result.body).not.toContain("| | What | Where |");
  });

  it("unanchored finding permalink, suggestion and below", () => {
    const { body } = plan({ findings: [finding({ line: 99, start_line: 98 }), finding({ id: "note", blocks: false })] });
    expect(body).toContain("\n\nhttps://github.com/acme/widgets/blob/" + context.head_sha + "/src/A.cs#L98-L99\n\n");
    expect(body).toContain("Suggested change:\n```\nreturn budget;\n```");
    expect(body).not.toContain("```suggestion");
    expect(body).toContain("| 🔴 | The budget is exceeded. | below |");
    expect(body).toContain("<!-- review:finding budget -->\n\n---");
    expect(
      body.endsWith(
        "<!-- review:finding budget -->\n<!-- review:state budget open -->\n\n" +
          `<!-- review:record head=${context.head_sha} session=${sight.session} -->`,
      ),
    ).toBe(true);
  });

  it("start line only when shown and less than line", () => {
    for (const start of [null, 43, 44, 39]) {
      const comment = plan({ findings: [finding({ start_line: start })] }).comments[0];
      expect(comment, String(start)).not.toHaveProperty("start_line");
      expect(comment, String(start)).not.toHaveProperty("start_side");
    }
    expect(plan({ findings: [finding({ start_line: 41 })] }).comments[0]!.start_line).toBe(41);
  });

  it("leads, multiline quote and optional blocks", () => {
    const cases: [Json, string][] = [
      [{}, "Point"],
      [{ asked: "simple" }, "**Do you really need this?** Point"],
      [{ asked: "root" }, "Point"],
      [{ point: "**Already bold.**" }, "**Already bold.**"],
      [{ blocks: false }, "Point"],
    ];
    for (const [changes, expected] of cases) {
      const item = "point" in changes ? finding(changes) : finding({ point: "Point", body: "  ", suggestion: "\n ", proof: " ", ...changes });
      const text = plan({ findings: [item] }).comments[0]!.body;
      expect(lines(text)[1]).toBe("> " + expected);
    }
    const text = plan({ findings: [finding({ point: "First\n\nLast", body: "", proof: null, suggestion: null })] }).comments[0]!.body;
    expect(text).toBe("> [!WARNING]\n> First\n>\n> Last\n\n<!-- review:finding budget -->");
  });

  it("fence outgrows embedded backticks", () => {
    expect(render.fence("```python\n42\n```")).toBe("````\n```python\n42\n```\n````");
    expect(plan({ findings: [finding({ suggestion: "a ``` b" })] }).comments[0]!.body).toContain("````suggestion\na ``` b\n````");
    expect(render.fence("  code\n", "suggestion")).toBe("```suggestion\n  code\n```");
  });

  it("decision inline and unanchored templates", () => {
    const item = decision({ question: "Which?\nWhy?", options: [{ answer: "A|B", leads_to: "one\ntwo" }] });
    const text = plan({ decisions: [item] }).comments[0]!.body;
    expect(text).toBe(
      "> [!IMPORTANT]\n> **A decision for a person.** Which?\n> Why?\n\n" +
        "The default affects all callers.\n\n| Answer | Leads to |\n|---|---|\n" +
        "| **A\\|B** | one<br>two |\n\nReply in this thread with your answer.\n\n" +
        "<!-- review:decision limit -->",
    );
    const result = plan({ decisions: [decision({ line: 99, options: [] })] });
    expect(result.comments).toEqual([]);
    expect(result.body).toContain("/src/A.cs#L99\n\n");
    expect(result.body).toContain("Reply on this pull request with your answer.\n\n<!-- review:decision limit -->");
    expect(result.body).not.toContain("| Answer |");
  });

  it("every state reply and flags", () => {
    const cases: [string, string, boolean, boolean][] = [
      ["fixed", "✅ **Fixed.**", true, false],
      ["withdrawn", "↩️ **Withdrawn.**", true, false],
      ["declined", "🤝 **Declined. It will not be raised again.**", true, false],
      ["open", "🔴 **Open again.**", false, true],
    ];
    for (const [state, sentence, resolve, unresolve] of cases) {
      context.threads = [thread("finding", "budget", { resolved: state === "open" })];
      const result = plan({ findings: [finding({ state, reply: "Confirmed.", how: "reasoned" })] });
      expect(result.comments, state).toEqual([]);
      let expected = sentence + " Confirmed.";
      if (state === "open" || state === "fixed") {
        expected += "\n\n<details><summary>Reasoned, not run</summary>\n\nRun the budget test.\n\n</details>";
      }
      expected += `\n\n<!-- review:state budget ${state} -->`;
      expect(result.replies, state).toEqual([
        { root_comment_id: 123456, thread_node_id: "PRRT_budget", body: expected, resolve, unresolve },
      ]);
    }
  });

  it("state replies without optional text", () => {
    for (const [state, sentence] of [
      ["fixed", "✅ **Fixed.**"],
      ["withdrawn", "↩️ **Withdrawn.**"],
      ["declined", "🤝 **Declined. It will not be raised again.**"],
      ["open", "🔴 **Open again.**"],
    ]) {
      context.threads = [thread("finding", "budget", { resolved: true })];
      const reply = plan({ findings: [finding({ state, reply: "  ", proof: null })] }).replies[0]!;
      expect(reply.body).toBe(sentence + `\n\n<!-- review:state budget ${state} -->`);
    }
  });

  it("open reply to author only", () => {
    context.threads = [thread()];
    const reply = plan({ findings: [finding({ reply: "Still fails." })] }).replies[0]!;
    expect(reply.body).toBe("Still fails.\n\n<!-- review:state budget open -->");
    expect(reply.resolve || reply.unresolve).toBe(false);
    for (const last of [true, false]) {
      context.threads[0]!.comments!.at(-1)!.is_reviewer = last;
      expect(plan({ findings: [finding({ reply: last ? "Hello" : null })] }).replies).toEqual([]);
    }
    context.threads[0]!.comments = [];
    expect(plan({ findings: [finding({ reply: "Hello" })] }).replies).toEqual([]);
  });

  it("repeated states are silent but reopened thread replies", () => {
    for (const state of ["fixed", "withdrawn", "declined"]) {
      context.threads = [thread("finding", "budget", { states: [state] })];
      const result = plan({ findings: [finding({ state })] });
      expect(result.comments.length || result.replies.length).toBe(0);
    }
    context.threads = [thread("finding", "budget", { states: ["open"], resolved: true })];
    expect(plan({ findings: [finding()] }).replies[0]!.unresolve).toBe(true);
  });

  it("answered decision and no reply cases", () => {
    context.threads = [thread("decision", "limit")];
    for (const [answer, sentence] of [
      ["Small", "☑️ **Decided: Small.**"],
      [null, "☑️ **Decided.**"],
      [" ", "☑️ **Decided.**"],
    ] as const) {
      const reply = plan({ decisions: [decision({ state: "answered", answer })] }).replies[0]!;
      expect(reply.body).toBe(sentence + "\n\n<!-- review:state limit answered -->");
      expect(reply.resolve).toBe(true);
      expect(reply.unresolve).toBe(false);
    }
    expect(plan({ decisions: [decision()] }).replies).toEqual([]);
    context.threads[0]!.states = ["answered"];
    expect(plan({ decisions: [decision({ state: "answered" })] }).replies).toEqual([]);
  });

  it("at most one reply per thread", () => {
    context.threads = [thread()];
    expect(plan({ findings: [finding({ state: "fixed" }), finding({ state: "fixed" })] }).replies).toHaveLength(1);
  });

  it("state table order, icons and where", () => {
    let items = [
      finding({ id: "declined", state: "declined" }), finding({ id: "note", blocks: false }),
      finding({ id: "withdrawn", state: "withdrawn" }), finding({ id: "fixed", state: "fixed" }),
      finding({ id: "block1", path: null }), finding({ id: "block2", start_line: 41 }),
    ];
    context.threads = ["declined", "withdrawn", "fixed"].map((state) => thread("finding", state));
    context.threads.push(thread("decision", "answered"));
    items = items.map((item) => ({ ...item, point: item.id }));
    const { body } = plan({
      findings: items,
      decisions: [decision({ id: "answered", state: "answered", question: "answered" }), decision({ id: "open", question: "decision" })],
    });
    const icons = ["🔴", "❓", "💬", "✅", "☑️", "↩️", "🤝"];
    const rows = lines(body)
      .filter((line) => icons.some((icon) => line.startsWith(`| ${icon} |`)))
      .slice(0, 8);
    expect(rows.map((line) => line.split(" | ")[1])).toEqual(["block1", "block2", "decision", "note", "fixed", "answered", "withdrawn", "declined"]);
    expect(rows.map((line) => line.split(" | ")[0]!.slice(2))).toEqual(["🔴", "🔴", "❓", "💬", "✅", "☑️", "↩️", "🤝"]);
    expect(rows[0]).toContain("| below |");
    expect(rows[1]).toContain("[`A.cs`, lines 41–43]");
    expect(rows[2]).toContain("[`A.cs`, line 42]");
    expect(rows[4]).toContain("[thread](https://github.com/acme/widgets/pull/712#discussion_r123456)");
  });

  it("approve shows one row and unanchored notes after the frame", () => {
    const { body } = plan({ findings: [finding({ blocks: false, path: null })] });
    expect(body.startsWith("<details><summary>LGTM :shipit:</summary>")).toBe(true);
    expect(body).toContain("| 💬 | The budget is exceeded. | below |");
    expect(body).toContain("</details>\n\n---\n\n> [!NOTE]");
  });

  it("unpublished closed items have no row", () => {
    const result = plan({ findings: [finding({ state: "fixed" })], decisions: [decision({ state: "answered" })] });
    expect(result.body).not.toContain("| | What | Where |");
    expect(result.comments.length || result.replies.length).toBe(0);
  });

  it("rests on URI forms", () => {
    const body = plan({
      findings: [
        finding({
          rests_on: [
            "concept:///rule/Name.md", "file:///src/A.cs#symbol=Foo", "https://example.com/docs/rule?q=1#part",
            "http://example.com/path", "unusual:thing",
          ],
        }),
      ],
    }).comments[0]!.body;
    const base = "https://github.com/acme/widgets/blob/" + context.head_sha;
    expect(body).toContain(
      `Rests on [Name](${base}/.repoql/concepts/rule/Name.md), [\`A.cs\`](${base}/src/A.cs), ` +
        "[rule](https://example.com/docs/rule?q=1#part), [path](http://example.com/path), `unusual:thing`.",
    );
  });

  it("basis fixed order, escaping, missing rows and not checked", () => {
    const basis = [
      { asked: "simple", result: "unknown", how: "unchecked", detail: " z|x\nnext " },
      { asked: "works", result: "fail", how: "reasoned", detail: "Bad." },
    ];
    const { body } = plan({ basis, not_checked: ["one", "two"] });
    expect(body).toContain(
      "| ❌ | Works | reasoned | Bad. |\n| ❔ | No more than it needs | unchecked | z\\|x<br>next |\n" +
        "| ⚪ | Not checked | | one |\n| ⚪ | Not checked | | two |",
    );
    expect(body).not.toContain("Delivers its intent");
    expect(plan({ basis: [] }).body).not.toContain("| | Asked |");
  });

  it("proof labels and lesson", () => {
    for (const [how, label] of [
      ["demonstrated", "Proof"],
      ["reasoned", "Reasoned, not run"],
      ["unchecked", "Not checked"],
    ]) {
      expect(plan({ findings: [finding({ how })] }).comments[0]!.body).toContain(`<details><summary>${label}</summary>`);
    }
    const lesson = {
      name: "BoundReads", category: "rule", invariant: "Bound reads.\n\nAlways.", why: "Callers need limits.",
      relevance: "file:///src/**", tags: "read, budget", from: "budget",
    };
    const result = plan({ lessons: [lesson] });
    expect(result.lessons).toBe(
      "> [!TIP]\n> **Worth capturing as a concept.** The review of `aaaaaaaaa` surfaced a rule " +
        "the team will want again. Capture it with `capture_concept` in this pull request.\n\n" +
        "### 💡 BoundReads\n\n> Bound reads.\n>\n> Always.\n\nCallers need limits.\n\n" +
        "`rule` · applies to `file:///src/**` · tags: read, budget · from `budget`\n\n" +
        "<!-- review:lesson BoundReads -->",
    );
    expect(result.body).not.toContain("BoundReads");
    expect(render.markdown(result)).toContain("--- comment on the pull request ---\n\n> [!TIP]");
    const two = plan({ lessons: [lesson, { ...lesson, name: "Second Rule" }] }).lessons;
    expect(two).toContain(
      "**Worth capturing as concepts.** The review of `aaaaaaaaa` surfaced rules the team will " +
        "want again. Capture each with `capture_concept` in this pull request.",
    );
    expect(two.endsWith("<!-- review:lesson BoundReads -->\n<!-- review:lesson SecondRule -->")).toBe(true);
    expect(render.trailingMarkers(two)).toEqual([
      ["lesson", "BoundReads", ""],
      ["lesson", "SecondRule", ""],
    ]);
    expect(plan().lessons).toBe("");
    expect(render.render(null, context, sight).lessons).toBe("");
  });

  it("session words and final marker", () => {
    for (const [session, words] of [
      ["continued", "continued"],
      ["new", "new"],
      ["fresh", "new, on request"],
      ["lost", "new: the earlier one could not be restored"],
    ] as const) {
      sight.session = session;
      const { body } = plan();
      expect(body).toContain(`<sub>Reviewed \`aaaaaaaaa\` · session ${words} · rql built from this PR · gpt-6.1-sol`);
      expect(body.endsWith(`<!-- review:record head=${context.head_sha} session=${session} -->`)).toBe(true);
    }
  });

  it("the second opinion names the command the workflow answers", () => {
    expect(plan().body).toContain("comment `/codex-review fresh` for a second opinion");
    sight.command = "/review";
    expect(plan().body).toContain("comment `/review fresh` for a second opinion");
  });

  it("unusable records", () => {
    const missing = record();
    delete missing.findings;
    const values: unknown[] = [
      null, "not JSON", missing, record({ verdict: "maybe" }), record({ findings: [finding({ line: true })] }),
      record({ extra: "not allowed" }), record({ decisions: [decision({ options: [{ answer: "yes" }] })] }),
    ];
    for (const value of values) {
      const result = render.render(value, context, sight, "raw ``` final");
      const label = JSON.stringify(value);
      expect(result.verdict, label).toBe("undetermined");
      expect(result.comments.length || result.replies.length, label).toBe(0);
      expect(lines(result.body).slice(0, 2), label).toEqual([
        "> [!CAUTION]",
        "> **Could not establish whether this change is correct.** The reviewer did not return a structured review. Its final message is below.",
      ]);
      expect(result.body, label).toContain("<details><summary>The reviewer's final message</summary>\n\n````\nraw ``` final\n````");
      expect(result.body, label).not.toContain("| | Asked |");
    }
  });

  it("validation matches all required schema keys", () => {
    interface Definition {
      required?: string[];
      properties?: Record<string, Definition>;
      items?: Definition;
    }
    const schema = JSON.parse(readFileSync(join(ROOT, "record.schema.json"), "utf8")) as Definition;
    const full = record({
      findings: [finding()],
      decisions: [decision()],
      lessons: [{ name: "N", category: "rule", invariant: "I", why: "W", relevance: "*", tags: "t", from: "budget" }],
    });

    function visit(value: unknown, definition: Definition, path: (string | number)[] = []): void {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of definition.required!) {
          const modified = structuredClone(full);
          let parent: Record<string | number, unknown> = modified;
          for (const segment of path) parent = parent[segment] as Record<string | number, unknown>;
          delete parent[key];
          expect(render.validRecord(modified), JSON.stringify([...path, key])).toBe(false);
        }
        for (const [key, child] of Object.entries(value)) visit(child, definition.properties![key]!, [...path, key]);
      } else if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, definition.items!, [...path, index]));
      }
    }
    expect(render.validRecord(full)).toBe(true);
    visit(full, schema);
  });

  it("impaired alerts always come first", () => {
    sight.impaired = ["Released rql.\nNo build.", "No live test."];
    const prefix = "> [!CAUTION]\n> Released rql.\n> No build.\n\n> [!CAUTION]\n> No live test.\n\n";
    for (const value of [record(), null]) {
      expect(render.render(value, context, sight).body.startsWith(prefix)).toBe(true);
    }
  });

  it("inputs are not mutated", () => {
    const value = record({ findings: [finding({ path: "./src/A.cs", start_line: 39 })] });
    const before = structuredClone([value, context, sight]);
    render.render(value, context, sight);
    expect([value, context, sight]).toStrictEqual(before);
  });

  it("CLI: invalid JSON, missing file and raw", async () => {
    const directory = mkdtempSync(join(tmpdir(), "render-test-"));
    try {
      const [bad, raw, out] = ["bad.json", "raw.txt", "plan.json"].map((name) => join(directory, name)) as [string, string, string];
      writeFileSync(bad, "not JSON");
      writeFileSync(raw, "Original final message.");
      const common = ["--context", join(ROOT, "fixtures/context.json"), "--sight", join(ROOT, "fixtures/sight.json")];
      const io = { emit: (_line: string) => {}, environ: {} };
      for (const source of [bad, join(directory, "missing.json")]) {
        expect(await render.main([...common, "--record", source, "--raw", raw, "--out", out], io)).toBe(0);
        expect((JSON.parse(readFileSync(out, "utf8")) as Plan).body).toContain("Original final message.");
      }
      const stdout: string[] = [];
      await render.main([...common, "--raw", raw, "--markdown"], { emit: (line) => stdout.push(line), environ: {} });
      expect(stdout.join("\n")).toContain("Original final message.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("markdown includes comments and replies", () => {
    context.threads = [thread("finding", "old")];
    const result = plan({ findings: [finding({ start_line: 41 }), finding({ id: "old", state: "fixed" })] });
    const text = render.markdown(result);
    expect(text).toContain("--- inline comment on src/A.cs:41-43 ---\n\n");
    expect(text).toContain("--- reply in thread 123456 ---\n\n");
    expect(text.indexOf("--- inline")).toBeLessThan(text.indexOf("--- reply"));
  });
});
