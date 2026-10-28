// Verify GitHub requests and publishing recovery with an injected GitHub.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as pullRequest from "../src/pull-request.js";
import type { PullRequestContext, ThreadNode } from "../src/pull-request.js";
import * as render from "../src/render.js";
import type { Context, Plan, Sight, Thread } from "../src/render.js";
import { FakeGitHub } from "./fake-github.js";
import type { Answer } from "./fake-github.js";

const ROOT = join(import.meta.dirname, "..");
const REPO = "acme/widgets";

type Json = Record<string, unknown>;
type Loose = any;

function fixture<T = Loose>(name: string): T {
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

/** A GitHub that answers each call with the next queued answer, and with an empty object once they run out. */
function fakeGh(answers: Answer[] = []): { github: FakeGitHub; queue: Answer[] } {
  const queue = [...answers];
  return { github: new FakeGitHub(() => queue.shift() ?? { data: {} }), queue };
}

/** What gh reported as a failed call: GitHub's refusal, with its text. */
function refused(text: string): Answer {
  return { status: 422, ok: false, data: null, text };
}

function graphPage(nodes: unknown[], more = false, cursor: string | null = null): Answer {
  return { data: { data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } } } } } } };
}

function gatherGh(): { github: FakeGitHub; queue: Answer[] } {
  const data = fixture("github.json");
  return fakeGh([
    { data: data.pr }, { data: data.files }, graphPage(data.threads.slice(0, 1), true, "next"), graphPage(data.threads.slice(1)),
    { data: data.reviews }, { data: data.conversation },
  ]);
}

function body(github: FakeGitHub, index: number): Loose {
  return github.calls.at(index)!.body;
}

const LESSON = {
  name: "BoundReads", category: "rule", invariant: "Bound reads.", why: "Callers need limits.",
  relevance: "file:///src/**", tags: "read, budget", from: "budget",
};

describe("PullRequestTests", () => {
  let context: Context;
  let sight: Sight;
  let messages: string[];

  beforeEach(() => {
    context = fixture<Context>("context.json");
    sight = fixture<Sight>("sight.json");
    messages = [];
  });

  function plan(changes: Json = {}): Plan {
    return render.render(record(changes), context, sight);
  }

  function publish(value: Plan, github: FakeGitHub, { dryRun = false, environ = {} as NodeJS.ProcessEnv } = {}): Promise<number> {
    return pullRequest.publish(github, REPO, 712, value, { dryRun, environ, emit: (line) => messages.push(line) });
  }

  it("patch: multiple hunks, deletions and no newline", () => {
    const patch =
      "@@ -1,3 +1,3 @@ title\n context\n-old\n+new\n last\n" +
      "\\ No newline at end of file\n@@ -10 +20,2 @@\n-old\n+first\n+second\n" +
      "@@ -30,2 +40,0 @@\n-deleted\n-deleted too";
    expect(pullRequest.shownLines(patch)).toEqual([1, 2, 3, 20, 21]);
    expect(pullRequest.shownLines(null)).toEqual([]);
  });

  it("gather pages, filters and fields", async () => {
    const { github, queue } = gatherGh();
    const gathered = await pullRequest.gather(github, REPO, 712);
    expect(gathered.shown["src/A.cs"]).toEqual([40, 41, 42, 43]);
    expect(gathered.shown["binary.bin"]).toEqual([]);
    expect(gathered.server_url).toBe("https://github.com");
    expect(gathered.threads[0]!.id).toBe("budget");
    expect(gathered.threads[0]!.states).toEqual(["fixed"]);
    expect(gathered.threads[0]!.comments![2]!.is_reviewer).toBe(true);
    expect(gathered.threads[1]!.kind).toBeNull();
    expect(gathered.reviews).toHaveLength(1);
    expect(gathered.reviews[0]!.head).toBe("b".repeat(40));
    expect(gathered.conversation.map((comment) => comment.author)).toEqual(["octocat"]);
    expect(gathered.lessons).toEqual([]);
    expect(body(github, 2).variables.cursor).toBeNull();
    expect(body(github, 3).variables.cursor).toBe("next");
    expect(body(github, 2).query).toContain("comments(first: 100)");
    expect(github.calls[1]!.paginated).toBe(true);
    expect(github.calls[4]!.paginated).toBe(true);
    expect(github.calls[5]!.paginated).toBe(true);
    expect(queue).toEqual([]);
  });

  it("marker trust and first comment only", () => {
    const node = fixture("github.json").threads[0] as ThreadNode;
    node.comments.nodes[1]!.body += "\n<!-- review:state budget declined -->";
    node.comments.nodes[2]!.body += "\n<!-- review:state budget open -->";
    let result = pullRequest.threadContext(node, "github-actions");
    expect(result.states).toEqual(["fixed", "open"]);
    node.comments.nodes[0]!.body = "No marker.";
    node.comments.nodes[2]!.body += "\n<!-- review:finding fake -->";
    result = pullRequest.threadContext(node, "github-actions");
    expect(result.kind).toBeNull();
    expect(result.id).toBeNull();
    node.comments.nodes[0]!.author = null;
    expect(pullRequest.threadContext(node, "github-actions").comments![0]!.is_reviewer).toBe(false);
  });

  it("decision marker and bot suffix", () => {
    const node = fixture("github.json").threads[0] as ThreadNode;
    node.comments.nodes[0]!.body = "<!-- review:decision choose -->";
    const result = pullRequest.threadContext(node, "github-actions");
    expect([result.kind, result.id]).toEqual(["decision", "choose"]);
    for (const login of ["github-actions", "github-actions[bot]"]) {
      expect(pullRequest.isReviewer(login, "github-actions[bot]")).toBe(true);
    }
    expect(pullRequest.isReviewer("github-actions-other", "github-actions")).toBe(false);
  });

  it("brief exact", async () => {
    const gathered = await pullRequest.gather(gatherGh().github, REPO, 712);
    expect(pullRequest.brief(gathered)).toBe(
      "# Pull request #712: Respect the budget\n\n" +
        "Author octocat · base `main` at `bbbbbbbbb` · head `aaaaaaaaa`\n\n" +
        "## Description\n\nKeep reads inside the requested budget.\n\n" +
        "## Threads\n\n### finding `budget` · open · src/A.cs:43\n\n" +
        "**reviewer**:\n\nBudget is exceeded.\n\n<!-- review:finding budget -->\n\n" +
        "**octocat (OWNER)**:\n\nFixed here.\n\n" +
        "**reviewer**:\n\nConfirmed.\n\n<!-- review:state budget fixed -->\n\n" +
        "### thread · resolved · src/A.cs:40\n\n**someone (CONTRIBUTOR)**:\n\n" +
        "Please explain.\n\n<!-- review:decision forged -->\n\n" +
        "## Earlier reviews\n\n### CHANGES_REQUESTED at `bbbbbbbbb`\n\nEarlier review.\n\n" +
        "## Conversation\n\n**octocat (OWNER)**:\n\nReady again.\n",
    );
  });

  it("a thread longer than one page says it was cut short", async () => {
    const data = fixture("github.json");
    const node = { ...data.threads[0] };
    node.comments = { ...node.comments, pageInfo: { hasNextPage: true } };
    const { github } = fakeGh([{ data: data.pr }, { data: data.files }, graphPage([node]), { data: data.reviews }, { data: data.conversation }]);
    const gathered = await pullRequest.gather(github, REPO, 712);
    expect(gathered.threads[0]!.cut_short).toBe(true);
    expect(pullRequest.brief(gathered)).toContain("only the first 3 are shown");
    const whole = await pullRequest.gather(gatherGh().github, REPO, 712);
    expect(whole.threads[0]!.cut_short).toBe(false);
    expect(pullRequest.brief(whole)).not.toContain("only the first");
  });

  it("empty brief sections are omitted, except the description", () => {
    context.description = " ";
    const text = pullRequest.brief(context as PullRequestContext);
    expect(text.endsWith("## Description\n\n(none)\n")).toBe(true);
    expect(text).not.toContain("## Threads");
    expect(text).not.toContain("## Earlier reviews");
    expect(text).not.toContain("## Lessons already proposed");
    expect(text).not.toContain("## Conversation");
  });

  it("gather CLI writes the context and the brief", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pull-request-test-"));
    try {
      const out = join(directory, "context.json");
      const brief = join(directory, "brief.md");
      const io = { emit: (line: string) => messages.push(line), environ: {}, github: gatherGh().github };
      expect(await pullRequest.main(["gather", "--repo", REPO, "--pr", "712", "--out", out, "--brief", brief], io)).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).number).toBe(712);
      expect(readFileSync(brief, "utf8").startsWith("# Pull request #712:")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("dry run order and payloads", async () => {
    context.threads = [thread()];
    const value = plan({ findings: [finding({ state: "fixed" })] });
    const { github } = fakeGh();
    const env = { GITHUB_SERVER_URL: "https://git.example", GITHUB_REPOSITORY: "O/R", GITHUB_RUN_ID: "88" };
    expect(await publish(value, github, { dryRun: true, environ: env })).toBe(0);
    expect(github.calls).toEqual([]);
    const requests = messages.slice(0, -1).map((line) => JSON.parse(line));
    expect(requests.map((row) => row.path)).toEqual([
      "repos/acme/widgets/pulls/712/reviews", "repos/acme/widgets/pulls/712/comments/123456/replies",
      "graphql", "repos/acme/widgets/statuses/" + "a".repeat(40),
    ]);
    expect(requests.map((row) => row.method)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(requests[2].payload.query).toContain("resolveReviewThread");
    expect(requests[2].payload.variables).toEqual({ id: "PRRT_budget" });
    expect(requests[3].payload.target_url).toBe("https://git.example/O/R/actions/runs/88");
    expect(messages.at(-1)).toBe("approve · APPROVE · 0 comments · 1 replies");
    // json.dumps spacing, as the Python publisher printed it.
    expect(messages[0]!.startsWith('{"method": "POST", "path": "repos/acme/widgets/pulls/712/reviews", "payload": {')).toBe(true);
  });

  it("lessons are published as a comment of their own", async () => {
    const value = plan({ lessons: [LESSON] });
    const { github } = fakeGh();
    expect(await publish(value, github)).toBe(0);
    expect(github.calls.map((call) => call.path)).toEqual([
      "repos/acme/widgets/pulls/712/reviews", "repos/acme/widgets/issues/712/comments",
      "repos/acme/widgets/statuses/" + "a".repeat(40),
    ]);
    expect(body(github, 1)).toEqual({ body: value.lessons });
    expect(body(github, 0).body).not.toContain("BoundReads");
  });

  it("a refused lessons comment warns and the status still publishes", async () => {
    const { github } = fakeGh([{ data: {} }, refused("refused"), { data: {} }]);
    expect(await publish(plan({ lessons: [LESSON] }), github)).toBe(0);
    expect(messages[0]).toBe("::warning::Could not publish the proposed concepts: refused");
    expect(body(github, -1).state).toBe("success");
  });

  it("a later review is told the lessons already proposed", async () => {
    const data = fixture("github.json");
    const proposed = plan({ lessons: [LESSON] }).lessons;
    const reviewer = { login: "github-actions[bot]", type: "Bot" };
    // A marker quoted inside another comment from the same login names no lesson.
    data.conversation.push(
      { user: reviewer, body: proposed },
      { user: reviewer, body: "## Test Results\n\n`<!-- review:lesson Quoted -->` passed." },
      { user: { login: "octocat", type: "User" }, author_association: "OWNER", body: proposed, created_at: "2026-10-01T07:00:00Z" },
    );
    const { github } = fakeGh([{ data: data.pr }, { data: data.files }, graphPage(data.threads), { data: data.reviews }, { data: data.conversation }]);
    const gathered = await pullRequest.gather(github, REPO, 712);
    expect(gathered.lessons).toEqual([proposed]);
    expect(pullRequest.brief(gathered)).toContain(
      "## Earlier reviews\n\n### CHANGES_REQUESTED at `bbbbbbbbb`\n\nEarlier review.\n\n" +
        "## Lessons already proposed\n\n" + proposed + "\n\n## Conversation",
    );
  });

  it("publish CLI dry run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pull-request-test-"));
    try {
      const path = join(directory, "plan.json");
      writeFileSync(path, JSON.stringify(plan()));
      const { github } = fakeGh();
      const code = await pullRequest.main(["publish", "--repo", "O/R", "--pr", "3", "--plan", path, "--dry-run"], {
        emit: (line) => messages.push(line), environ: {}, github,
      });
      expect(code).toBe(0);
      expect(github.calls).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("an approval refusal retries as a comment once", async () => {
    const { github } = fakeGh([refused("denied"), { data: {} }, { data: {} }]);
    expect(await publish(plan(), github)).toBe(0);
    expect(github.calls.slice(0, 2).map((call) => (call.body as Loose).event)).toEqual(["APPROVE", "COMMENT"]);
    expect(body(github, 1).body).toContain("GitHub refused the approval, so it is recorded here as a comment.\n\n<!-- review:record");
    expect(body(github, -1).state).toBe("success");
    expect(messages.at(-1)).toContain("approve · COMMENT");
  });

  it("an inline refusal moves comments with place labels and plain fences", async () => {
    const { github } = fakeGh([refused("Bad line"), { data: {} }, { data: {} }]);
    const value = plan({ findings: [finding({ start_line: 41, suggestion: "a ``` b" })], decisions: [decision()] });
    expect(await publish(value, github)).toBe(0);
    const retry = body(github, 1);
    expect(retry.comments).toEqual([]);
    expect(retry.event).toBe("REQUEST_CHANGES");
    expect(retry.body).toContain("---\n\n[`A.cs`, lines 41–43](https://github.com/acme/widgets/blob/" + "a".repeat(40) + "/src/A.cs#L41-L43)");
    expect(retry.body).toContain("[`A.cs`, line 42]");
    expect(retry.body).toContain("````\na ``` b\n````");
    expect(retry.body).not.toContain("````suggestion");
    expect(retry.body.endsWith("<!-- review:record head=" + "a".repeat(40) + " session=continued -->")).toBe(true);
    expect(value.comments).toHaveLength(2);
  });

  it("both fallbacks in order", async () => {
    const { github } = fakeGh([refused("approval denied"), refused("bad lines"), { data: {} }, { data: {} }]);
    const value = plan({ findings: [finding({ blocks: false })] });
    expect(await publish(value, github)).toBe(0);
    const reviews = github.calls.slice(0, 3).map((call) => call.body as Loose);
    expect(reviews.map((payload) => payload.event)).toEqual(["APPROVE", "COMMENT", "COMMENT"]);
    expect(reviews.map((payload) => payload.comments.length)).toEqual([1, 1, 0]);
    expect(reviews.at(-1).body.split("GitHub refused the approval").length - 1).toBe(1);
  });

  it("a final refusal exits one without replies or status", async () => {
    const { github } = fakeGh([refused("no"), refused("still no"), refused("final response\ndetail")]);
    expect(await publish(plan({ findings: [finding({ blocks: false })] }), github)).toBe(1);
    expect(github.calls).toHaveLength(3);
    expect(messages.at(-2)).toBe("final response\ndetail");
    expect(messages.at(-1)).toBe("::error::The review could not be submitted.");
  });

  it("a refusal without comments has no inline retry", async () => {
    const { github } = fakeGh([refused("no")]);
    expect(await publish(plan({ verdict: "request_changes" }), github)).toBe(1);
    expect(github.calls).toHaveLength(1);
  });

  it("a reply failure continues without resolving the failed reply", async () => {
    context.threads = [thread("finding", "first"), thread("finding", "second")];
    const { github } = fakeGh([{ data: {} }, refused("reply rejected"), { data: {} }, { data: {} }, { data: {} }]);
    expect(await publish(plan({ findings: [finding({ id: "first", state: "fixed" }), finding({ id: "second", state: "fixed" })] }), github)).toBe(0);
    expect(github.calls).toHaveLength(5);
    expect(body(github, 3).variables.id).toBe("PRRT_second");
    expect(messages[0]!.startsWith("::warning::")).toBe(true);
  });

  it("GraphQL and status failures warn and continue", async () => {
    context.threads = [thread("finding", "budget", { resolved: true })];
    const { github } = fakeGh([{ data: {} }, { data: {} }, { data: { errors: [{ message: "Cannot reopen" }] } }, refused("status rejected")]);
    expect(await publish(plan({ findings: [finding()] }), github)).toBe(0);
    expect(body(github, 2).query).toContain("unresolveReviewThread");
    expect(messages.filter((line) => line.startsWith("::warning::"))).toHaveLength(2);
    expect(body(github, 3)).not.toHaveProperty("target_url");
  });
});

/** The reviewer's own regression: proof that quotes a marker must not rename its thread. */
describe("AMarkerQuotedInProofIsNotAMarker", () => {
  let context: Context;
  let sight: Sight;
  let item: Json;

  beforeEach(() => {
    context = fixture<Context>("context.json");
    sight = fixture<Sight>("sight.json");
    // Quoted every way markdown allows: in a line of code, in backtick and tilde
    // fences, indented, and bare on a line of its own.
    item = finding({
      id: "marker-in-proof",
      proof:
        '```python\nroot = "<!-- review:finding example -->"\n```\n\n' +
        "```\n<!-- review:finding fenced -->\n<!-- review:state marker-in-proof fixed -->\n```\n\n" +
        "~~~\n<!-- review:state marker-in-proof fixed -->\n~~~\n\n" +
        "   ```\n   <!-- review:state marker-in-proof fixed -->\n   ```\n\n" +
        "<!-- review:state marker-in-proof withdrawn -->\n\nAnd then more words.",
    });
    const first = render.render(record({ findings: [item] }), context, sight);
    const node = fixture("github.json").threads[0] as ThreadNode;
    const root = node.comments.nodes[0]!;
    node.comments.nodes = [{ ...root, body: first.comments[0]!.body }];
    context.threads = [pullRequest.threadContext(node, "github-actions[bot]")];
    context.reviews = [{ body: first.body }];
  });

  it("the thread keeps the name the publisher gave it", () => {
    const [kept] = context.threads;
    expect([kept!.kind, kept!.id, kept!.states]).toEqual(["finding", "marker-in-proof", []]);
  });

  it("the finding is not published twice", () => {
    const again = render.render(record({ findings: [item] }), context, sight);
    expect(again.comments).toEqual([]);
  });

  it("its fix is confirmed in the real thread", () => {
    const fixed = { ...item, state: "fixed", reply: "The check passes." };
    const again = render.render(record({ findings: [fixed] }), context, sight);
    expect(again.replies).toHaveLength(1);
    expect(again.replies[0]!.resolve).toBe(true);
    expect(again.replies[0]!.body).toContain("The check passes.");
  });

  it("an answer that ends by quoting a marker does not hide the fix that follows", () => {
    const answer = { ...item, reply: "It reads the last line:\n\n<!-- review:state marker-in-proof fixed -->" };
    const threadNow = context.threads[0]!;
    threadNow.comments!.push({ author: "author", association: "OWNER", is_reviewer: false, body: "Why?", created_at: "later" });
    const said = render.render(record({ findings: [answer] }), context, sight).replies[0]!.body!;
    const node = fixture("github.json").threads[0] as ThreadNode;
    const root = node.comments.nodes[0]!;
    node.comments.nodes = [{ ...root, body: threadNow.comments![0]!.body }, { ...root, body: said }];
    context.threads = [pullRequest.threadContext(node, "github-actions[bot]")];
    expect(context.threads[0]!.states!.at(-1)).toBe("open");
    const fixed = { ...item, state: "fixed", reply: "The check passes." };
    const confirmed = render.render(record({ findings: [fixed] }), context, sight).replies[0]!;
    expect(confirmed.body).toContain("The check passes.");
  });

  it("findings moved into the body are named at its end", () => {
    const value = render.render(record({ findings: [item] }), fixture<Context>("context.json"), sight);
    const payload = { commit_id: value.commit_id, event: value.event, body: value.body, comments: value.comments };
    pullRequest.moveComments(payload, REPO, "https://github.com");
    // The moved section's own last line is its marker, so the name can appear twice.
    const unique = [...new Map(render.trailingMarkers(payload.body).map((marker) => [JSON.stringify(marker), marker])).values()];
    expect(unique).toEqual([
      ["finding", "marker-in-proof", ""],
      ["state", "marker-in-proof", "open"],
    ]);
    expect(payload.body.trimEnd().endsWith("-->")).toBe(true);
    expect(payload.body.split("\n").at(-1)).toContain("<!-- review:record head=");
  });

  it("a thread edited in the browser keeps its name", () => {
    const node = fixture("github.json").threads[0] as ThreadNode;
    const root = node.comments.nodes[0]!;
    node.comments.nodes = [{ ...root, body: "A point.\r\n\r\n<!-- review:finding kept -->\r\n" }];
    expect(pullRequest.threadContext(node, "github-actions[bot]").id).toBe("kept");
  });

  it("a marker quoted in a review body names no earlier finding", () => {
    const unanchored = { ...item, path: null, line: null, suggestion: null };
    const first = render.render(record({ findings: [unanchored] }), fixture<Context>("context.json"), sight);
    expect(render.trailingMarkers(first.body)).toEqual([
      ["finding", "marker-in-proof", ""],
      ["state", "marker-in-proof", "open"],
    ]);
  });
});
