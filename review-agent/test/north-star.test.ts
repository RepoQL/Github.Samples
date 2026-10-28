/**
 * Checks the published review against what the north star promises a reader.
 *
 * Each case names the declaration in docs/north-star/code-review-agent.md it holds
 * the renderer to. The cases come from that document and from the verdict table in
 * docs/design/code-review-agent.md, never from the renderer's own behaviour.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { render } from "../src/render.js";
import type { Context, Plan, Sight, Thread } from "../src/render.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REPO_URL = "https://github.com/acme/widgets";

type Json = Record<string, unknown>;

function alerts(body: string): string[] {
  return [...body.matchAll(/^> \[!(\w+)\]$/gm)].map((match) => match[1]!);
}

function context(shown?: Record<string, number[]>, threads?: Thread[]): Context {
  return {
    repo: "acme/widgets", server_url: "https://github.com", number: 7,
    title: "Floors", description: "", author: "author",
    base_ref: "main", base_sha: "f".repeat(40), head_sha: HEAD,
    shown: shown ?? { "src/Floor.cs": [40, 41, 42, 43, 44] },
    threads: threads ?? [], reviews: [], conversation: [],
  };
}

function sight(session = "continued", impaired: string[] = []): Sight {
  return { session, rql: "built from this PR", model: "model-x", run_url: REPO_URL + "/actions/runs/1/attempts/1", impaired: [...impaired] };
}

function basis(results: Json): Json[] {
  return ["works", "delivers", "root", "spirit", "simple"].map((asked) => ({
    asked, result: results[asked] ?? "pass", how: "demonstrated", detail: asked + " detail",
  }));
}

interface RecordOptions {
  verdict?: string;
  headline?: string;
  findings?: Json[];
  decisions?: Json[];
  lessons?: Json[];
  not_checked?: string[];
  spidey_sense?: string[];
  [result: string]: unknown;
}

function record({
  verdict = "approve", headline = "", findings = [], decisions = [], lessons = [], not_checked = [], spidey_sense = [], ...results
}: RecordOptions = {}): Json {
  return {
    verdict, headline, basis: basis(results), not_checked: [...not_checked], spidey_sense: [...spidey_sense],
    findings: [...findings], decisions: [...decisions], lessons: [...lessons],
  };
}

function finding(over: Json = {}): Json {
  return {
    id: "floor-names-refused-budget", state: "open", blocks: true, asked: "works",
    how: "demonstrated", path: "src/Floor.cs", start_line: 41, line: 43,
    point: "A refused read names a budget that is refused again.",
    body: "The cheapest rendering can itself be a refusal.",
    suggestion: "var floor = Price(cheapestDeliverable);",
    proof: '- read at 10 tokens → "needs 113"\n- read at 113 tokens → "needs 174"',
    rests_on: ["concept:///rule/agent-experience/ActionableErrors.md"], reply: null,
    ...over,
  };
}

function decision(over: Json = {}): Json {
  return {
    id: "expired-link-renews", state: "open", path: "src/Floor.cs", line: 42,
    question: "Should an expired link renew itself, as the change does, or show an error, as the plan says?",
    context: "The plan's third criterion says an error.",
    options: [
      { answer: "Renew", leads_to: "the plan changes; the code stays" },
      { answer: "Show an error", leads_to: "the author removes the renewal" },
    ],
    answer: null, reply: null,
    ...over,
  };
}

function thread(kind: string, itemId: string, { resolved = false, states = [] as string[], lastIsReviewer = true } = {}): Thread {
  const comments = [
    { author: "github-actions", association: "NONE", is_reviewer: true, body: `…\n\n<!-- review:${kind} ${itemId} -->`, created_at: "2026-01-01T00:00:00Z" },
  ];
  if (!lastIsReviewer) {
    comments.push({ author: "author", association: "OWNER", is_reviewer: false, body: "It needs to stay.", created_at: "2026-01-02T00:00:00Z" });
  }
  return { node_id: "PRRT_" + itemId, resolved, path: "src/Floor.cs", line: 43, kind, id: itemId, states: [...states], root_comment_id: 555, comments };
}

/** What a reader sees without opening anything: the body minus folds and hidden markers. */
function visibleOutsideFolds(body: string): string {
  const innermost = /<details><summary>([^<]*)<\/summary>(?:(?!<details>)[\s\S])*?<\/details>/g;
  let text = body;
  while (new RegExp(innermost.source).test(text)) text = text.replace(innermost, (_fold, summary: string) => summary);
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** A maintainer should be able to take in an approval as one quiet line. */
describe("AnApprovalIsOneQuietLine", () => {
  it("the whole visible review is the approval line", () => {
    const plan = render(record({ not_checked: ["the multi-hour indexing benchmark"] }), context(), sight());
    expect(visibleOutsideFolds(plan.body)).toBe("LGTM :shipit:");
  });

  it("the approval carries no alert", () => {
    const plan = render(record(), context(), sight());
    expect(alerts(plan.body)).toEqual([]);
    expect(plan.body.startsWith("<details><summary>LGTM :shipit:</summary>\n")).toBe(true);
  });

  /** A maintainer should be able to see what a verdict rests on. */
  it("what the verdict rests on is one click beneath it", () => {
    const plan = render(record({ not_checked: ["the multi-hour indexing benchmark"] }), context(), sight());
    const fold = /<details><summary>LGTM :shipit:<\/summary>([\s\S]*?)<\/details>/.exec(plan.body)![1]!;
    expect(fold).toContain("| ✅ | Works | demonstrated | works detail |");
    expect(fold).toContain("| ✅ | Delivers its intent | demonstrated | delivers detail |");
    expect(fold).toContain("| ✅ | Fixes the cause, not the symptom | demonstrated | root detail |");
    expect(fold).toContain("| ✅ | In the spirit of the repository | demonstrated | spirit detail |");
    expect(fold).toContain("| ✅ | No more than it needs | demonstrated | simple detail |");
    expect(fold).toContain("| ⚪ | Not checked | | the multi-hour indexing benchmark |");
  });

  /** A maintainer should be able to read what did not sit right with the reviewer, apart from what it established. */
  it("what did not sit right is beneath the verdict and changes nothing", () => {
    const unease = "The retry count and the timeout were chosen in different places.";
    const plan = render(record({ not_checked: ["the benchmark"], spidey_sense: [unease] }), context(), sight());
    expect(visibleOutsideFolds(plan.body)).toBe("LGTM :shipit:");
    expect(plan.body).toContain("| ⚪ | Not checked | | the benchmark |\n| 🕷️ | Spidey sense | | " + unease + " |");
    expect(plan.event).toBe("APPROVE");
    expect(render(record(), context(), sight()).body).not.toContain("Spidey sense");
  });

  it("it is a GitHub approval", () => {
    const plan = render(record(), context(), sight());
    expect(plan.event).toBe("APPROVE");
    expect(plan.status.state).toBe("success");
    expect(plan.status.context).toBe("review/verdict");
  });
});

/** The first sentence carries the point; the fix is accepted, not retyped; the proof is folded. */
describe("AFindingIsReadInSecondsAndActedOnInOneStep", () => {
  let plan: Plan;
  let comment: Plan["comments"][number];

  beforeEach(() => {
    plan = render(
      record({ verdict: "request_changes", headline: "A refused read names a budget that is refused again.", findings: [finding()], works: "fail" }),
      context(),
      sight(),
    );
    comment = plan.comments[0]!;
  });

  it("the point is the first thing read", () => {
    const lines = comment.body.split("\n");
    expect(lines[0]).toBe("> [!WARNING]");
    expect(lines[1]).toBe("> A refused read names a budget that is refused again.");
  });

  it("the fix is a suggestion on exactly the lines it replaces", () => {
    expect([comment.path, comment.start_line, comment.line]).toEqual(["src/Floor.cs", 41, 43]);
    expect(comment.side).toBe("RIGHT");
    expect(comment.body).toContain("```suggestion\nvar floor = Price(cheapestDeliverable);\n```");
  });

  /** Accepting a suggestion replaces exactly the commented lines, so a range the diff shows only in part offers none. */
  it("a fix is never offered on lines other than the ones it replaces", () => {
    const gap = context({ "src/Floor.cs": [40, 41, 43, 44] });
    const partial = render(record({ verdict: "request_changes", headline: "x", findings: [finding()], works: "fail" }), gap, sight());
    const only = partial.comments[0]!;
    expect(only.line).toBe(43);
    expect(only).not.toHaveProperty("start_line");
    expect(only.body).not.toContain("```suggestion");
    expect(only.body).toContain("Suggested change:\n```\nvar floor = Price(cheapestDeliverable);\n```");
  });

  it("the proof is folded and present", () => {
    expect(comment.body).toContain("<details><summary>Proof</summary>\n\n- read at 10 tokens");
  });

  /** A team should be able to see which concept a finding rests on. */
  it("the concept it rests on is one step away", () => {
    const link = `[ActionableErrors](${REPO_URL}/blob/${HEAD}/.repoql/concepts/rule/agent-experience/ActionableErrors.md)`;
    expect(comment.body).toContain(`Rests on ${link}.`);
  });

  it("the review requests changes", () => {
    expect(plan.event).toBe("REQUEST_CHANGES");
    expect(plan.status.state).toBe("failure");
    expect(plan.body.startsWith("> [!WARNING]\n> **Changes requested.** A refused read names a budget that is refused again.")).toBe(true);
  });

  it("a finding the diff cannot hold is still published with its code one step away", () => {
    const outside = render(
      record({ verdict: "request_changes", headline: "x", findings: [finding({ line: 90, start_line: null })], works: "fail" }),
      context(),
      sight(),
    );
    expect(outside.comments).toEqual([]);
    expect(outside.body).toContain(`\n${REPO_URL}/blob/${HEAD}/src/Floor.cs#L90\n`);
    expect(outside.body).toContain("<!-- review:finding floor-names-refused-budget -->");
    expect(outside.body).not.toContain("```suggestion");
  });

  /** A maintainer should be able to see what the reviewer demonstrated and what it only reasoned. */
  it("a reasoned finding does not call its reasoning proof", () => {
    const reasoned = render(
      record({ verdict: "request_changes", headline: "x", findings: [finding({ how: "reasoned" })], works: "fail" }),
      context(),
      sight(),
    );
    expect(reasoned.comments[0]!.body).toContain("<details><summary>Reasoned, not run</summary>");
    expect(reasoned.comments[0]!.body).not.toContain("<summary>Proof</summary>");
  });
});

/** A maintainer should be able to see at once whether a review holds a decision for them. */
describe("ADecisionStandsApartFromDefects", () => {
  let plan: Plan;

  beforeEach(() => {
    plan = render(record({ verdict: "needs_decision", headline: decision().question as string, decisions: [decision()] }), context(), sight());
  });

  it("the review opens with the question", () => {
    expect(plan.body.startsWith("> [!IMPORTANT]\n> **A decision for a person.** Should an expired link renew itself")).toBe(true);
  });

  it("the question sits at the line it concerns with what each answer leads to", () => {
    const comment = plan.comments[0]!;
    expect([comment.path, comment.line]).toEqual(["src/Floor.cs", 42]);
    expect(comment).not.toHaveProperty("start_line");
    expect(comment.body).toContain("| **Renew** | the plan changes; the code stays |");
    expect(comment.body).toContain("Reply in this thread with your answer.");
    expect(comment.body.trimEnd().endsWith("<!-- review:decision expired-link-renews -->")).toBe(true);
  });

  it("it neither approves nor requests changes", () => {
    expect(plan.event).toBe("COMMENT");
    expect(plan.status.state).toBe("pending");
  });
});

/** A reader should be able to scan a review and see its state: what blocks, what is fixed, what is a note. */
describe("EachAlertHasOneMeaning", () => {
  it("WARNING blocks, IMPORTANT asks a person, NOTE waits on nothing", () => {
    const note = finding({ id: "a-note", blocks: false, line: 44, start_line: null, suggestion: null });
    const plan = render(
      record({ verdict: "request_changes", headline: "x", findings: [finding(), note], decisions: [decision()], works: "fail" }),
      context(),
      sight(),
    );
    const kinds = Object.fromEntries(plan.comments.map((comment) => [comment.line, alerts(comment.body)]));
    expect(kinds).toEqual({ 43: ["WARNING"], 44: ["NOTE"], 42: ["IMPORTANT"] });
  });

  it("the state of everything is one table", () => {
    const note = finding({ id: "a-note", blocks: false, line: 44, start_line: null, point: "A note." });
    const fixed = finding({ id: "was-fixed", state: "fixed", point: "Fixed thing." });
    const plan = render(
      record({ verdict: "request_changes", headline: "x", findings: [note, fixed, finding()], decisions: [decision()], works: "fail" }),
      context(undefined, [thread("finding", "was-fixed")]),
      sight(),
    );
    const rows = plan.body
      .split("\n")
      .filter((line) => /^\| \S+ \| /u.test(line))
      .map((line) => line.split(" | ")[0]!);
    const icons = rows.map((row) => row.replace(/^[| ]+/, "")).filter((icon) => ["🔴", "❓", "💬", "✅"].includes(icon));
    expect(icons.slice(0, 4)).toEqual(["🔴", "❓", "💬", "✅"]);
  });
});

/** A re-review continues the earlier one; a declined finding is not seen again. */
describe("TheReviewerRemembers", () => {
  it("a fix is confirmed in the thread that raised it", () => {
    const fixed = finding({ state: "fixed", reply: "Both reads are served now." });
    const plan = render(record({ findings: [fixed] }), context(undefined, [thread("finding", fixed.id as string)]), sight());
    expect(plan.comments).toEqual([]);
    const reply = plan.replies[0]!;
    expect(reply.body!.startsWith("✅ **Fixed.** Both reads are served now.")).toBe(true);
    expect(reply.resolve).toBe(true);
    expect(reply.root_comment_id).toBe(555);
    expect(plan.event).toBe("APPROVE");
  });

  it("a confirmed fix is not confirmed twice", () => {
    const fixed = finding({ state: "fixed" });
    const plan = render(
      record({ findings: [fixed] }),
      context(undefined, [thread("finding", fixed.id as string, { resolved: true, states: ["fixed"] })]),
      sight(),
    );
    expect(plan.replies).toEqual([]);
    expect(plan.comments).toEqual([]);
  });

  it("a thread that could not be resolved is resolved later without more words", () => {
    const fixed = finding({ state: "fixed", reply: "Both reads are served now." });
    const plan = render(
      record({ findings: [fixed] }),
      context(undefined, [thread("finding", fixed.id as string, { resolved: false, states: ["fixed"] })]),
      sight(),
    );
    expect(plan.replies.map((reply) => [reply.body, reply.resolve])).toEqual([[null, true]]);
    const someoneAnswered = thread("finding", fixed.id as string, { resolved: false, states: ["fixed"], lastIsReviewer: false });
    const leftAlone = render(record({ findings: [fixed] }), context(undefined, [someoneAnswered]), sight());
    expect(leftAlone.replies).toEqual([]);
  });

  it("a declined finding is closed once and never raised again", () => {
    const declined = finding({ state: "declined" });
    const first = render(record({ findings: [declined] }), context(undefined, [thread("finding", declined.id as string)]), sight());
    expect(first.replies).toHaveLength(1);
    expect(first.replies[0]!.resolve).toBe(true);
    const again = render(
      record({ findings: [declined] }),
      context(undefined, [thread("finding", declined.id as string, { resolved: true, states: ["declined"] })]),
      sight(),
    );
    expect([again.comments, again.replies]).toEqual([[], []]);
    expect(again.event).toBe("APPROVE");
  });

  /** An author should be able to fix what a review found and have the next review confirm each fix. */
  it("a fix to a finding that had no thread is still confirmed", () => {
    const fixed = finding({ state: "fixed", path: null, line: null, start_line: null, point: "Five adapters still send the raw message." });
    const earlier = context();
    earlier.reviews = [
      { state: "CHANGES_REQUESTED", head: "a".repeat(40), submitted_at: "2026-01-01T00:00:00Z", body: "…\n\n<!-- review:finding floor-names-refused-budget -->" },
    ];
    Object.assign(fixed, { reply: "Verified fixed.", proof: "The check now passes." });
    const plan = render(record({ findings: [fixed] }), earlier, sight());
    expect(plan.body).toContain("| ✅ | Five adapters still send the raw message. | an earlier review |");
    expect(plan.body).toContain("> Five adapters still send the raw message.\n\n✅ **Fixed.** Verified fixed.");
    expect(plan.body).toContain("The check now passes.");
    expect([plan.comments, plan.replies]).toEqual([[], []]);
    expect(visibleOutsideFolds(plan.body)).toBe("LGTM :shipit:");
    const neverPublished = render(record({ findings: [fixed] }), context(), sight());
    expect(neverPublished.body).not.toContain("Five adapters");
  });

  it("a confirmation in a review body is not repeated by the next review", () => {
    const fixed = finding({ state: "fixed", path: null, line: null, start_line: null, proof: "The check now passes." });
    const earlier = context();
    earlier.reviews = [
      { state: "CHANGES_REQUESTED", head: "a".repeat(40), submitted_at: "1", body: "<!-- review:finding floor-names-refused-budget -->" },
      { state: "APPROVED", head: "b".repeat(40), submitted_at: "2", body: "<!-- review:state floor-names-refused-budget fixed -->" },
    ];
    const plan = render(record({ findings: [fixed] }), earlier, sight());
    expect(plan.body).not.toContain("The check now passes.");
    expect(plan.body).toContain("| ✅ |");
  });

  it("a finding without a thread that came back and was fixed again is confirmed again", () => {
    const item = finding({ path: null, line: null, start_line: null, suggestion: null });
    const history = context();
    for (const state of ["open", "fixed", "open"]) {
      const plan = render(record({ findings: [{ ...item, state }] }), history, sight());
      history.reviews!.push({ body: plan.body });
    }
    const again = render(
      record({ findings: [{ ...item, state: "fixed", reply: "Retested the second fix.", proof: "The second fix passes." }] }),
      history,
      sight(),
    );
    expect(again.body).toContain("Retested the second fix.");
    expect(again.body).toContain("The second fix passes.");
  });

  it("a finding fixed again after it came back is confirmed again", () => {
    const fixed = finding({ state: "fixed" });
    const plan = render(
      record({ findings: [fixed] }),
      context(undefined, [thread("finding", fixed.id as string, { states: ["fixed", "open"] })]),
      sight(),
    );
    expect(plan.replies).toHaveLength(1);
    expect(plan.replies[0]!.resolve).toBe(true);
  });

  it("an open finding is not repeated while nobody has answered", () => {
    const plan = render(
      record({ verdict: "request_changes", headline: "x", findings: [finding({ reply: "Still there." })], works: "fail" }),
      context(undefined, [thread("finding", finding().id as string)]),
      sight(),
    );
    expect([plan.comments, plan.replies]).toEqual([[], []]);
  });

  it("the reviewer answers an author who replied", () => {
    const plan = render(
      record({ verdict: "request_changes", headline: "x", findings: [finding({ reply: "The fold keeps both behaviours." })], works: "fail" }),
      context(undefined, [thread("finding", finding().id as string, { lastIsReviewer: false })]),
      sight(),
    );
    expect(plan.replies[0]!.body).toBe("The fold keeps both behaviours.\n\n<!-- review:state floor-names-refused-budget open -->");
    expect(plan.replies[0]!.resolve).toBe(false);
  });

  it("a reply that is no answer gets the question again and the change still waits", () => {
    const asked = decision({ reply: "Renew, or show an error?" });
    const plan = render(
      record({ verdict: "needs_decision", headline: asked.question as string, decisions: [asked] }),
      context(undefined, [thread("decision", asked.id as string, { lastIsReviewer: false })]),
      sight(),
    );
    expect(plan.replies[0]!.body).toBe("Renew, or show an error?\n\n<!-- review:state expired-link-renews open -->");
    expect(plan.replies[0]!.resolve).toBe(false);
    expect(plan.status.state).toBe("pending");
  });

  it("an answered decision is closed in its thread", () => {
    const answered = decision({ state: "answered", answer: "Show an error" });
    const plan = render(record({ decisions: [answered] }), context(undefined, [thread("decision", answered.id as string)]), sight());
    expect(plan.replies[0]!.body!.startsWith("☑️ **Decided: Show an error.**")).toBe(true);
    expect(plan.replies[0]!.resolve).toBe(true);
  });
});

/** A maintainer should be able to tell "nothing should hold this" from "I could not establish it". */
describe("TrustworthyOrLoudlyNot", () => {
  it("could not establish never looks like an approval", () => {
    const plan = render(record({ verdict: "undetermined", headline: "The change does not build." }), context(), sight());
    expect(plan.body.startsWith("> [!CAUTION]\n> **Could not establish whether this change is correct.** The change does not build.")).toBe(true);
    expect(plan.event).toBe("COMMENT");
    expect(plan.status.state).toBe("failure");
    expect(plan.body).not.toContain("LGTM");
  });

  it("an unusable record never approves", () => {
    for (const raw of ["", "not json", '{"verdict": "approve"}']) {
      const plan = render(null, context(), sight(), raw);
      expect(plan.event, raw).toBe("COMMENT");
      expect(plan.body, raw).not.toContain("LGTM");
      expect(plan.body, raw).toContain("[!CAUTION]");
    }
  });

  it("an approval that holds an open blocker is published as changes requested", () => {
    const plan = render(record({ verdict: "approve", findings: [finding()] }), context(), sight());
    expect(plan.event).toBe("REQUEST_CHANGES");
    expect(plan.body).not.toContain("LGTM");
  });

  /** A maintainer should be able to tell a review made with full sight from one made with less. */
  it("a review made with less sight says so outside the fold", () => {
    const plan = render(record(), context(), sight("continued", ["This review ran on the released rql."]));
    expect(plan.body.startsWith("> [!CAUTION]\n> This review ran on the released rql.")).toBe(true);
    expect(visibleOutsideFolds(plan.body)).toContain("This review ran on the released rql.");
  });

  it("every review states the head and the session it stood on", () => {
    let plan: Plan | undefined;
    for (const session of ["continued", "new", "fresh", "lost"]) {
      plan = render(record(), context(), sight(session));
      expect(plan.body.trimEnd().endsWith(`<!-- review:record head=${HEAD} session=${session} -->`)).toBe(true);
      expect(plan.body).toContain(`Reviewed \`${HEAD.slice(0, 9)}\``);
    }
    expect(plan!.commit_id).toBe(HEAD);
  });
});
