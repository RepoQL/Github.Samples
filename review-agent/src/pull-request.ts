/** Gather pull request context and publish review plans through the GitHub API. */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { read } from "./github-client.js";
import type { GitHub } from "./github-client.js";
import type { Io } from "./io.js";
import { TRAILER, WHITESPACE, placeLabel, rstrip, strip, trailingMarkers } from "./render.js";
import type { Context, InlineComment, Plan, Reply, Thread, ThreadComment } from "./render.js";

export const THREAD_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id isResolved resolvedBy { login } path line originalLine
          comments(first: 100) {
            nodes { databaseId author { login } authorAssociation body createdAt }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
`;

export interface ThreadNode {
  id: string;
  isResolved: boolean;
  resolvedBy?: { login?: string | null } | null;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  comments: {
    nodes: {
      databaseId: number;
      author?: { login?: string | null } | null;
      authorAssociation: string;
      body: string;
      createdAt: string;
    }[];
    pageInfo?: { hasNextPage?: boolean } | null;
  };
}

export interface GatheredReview {
  state: string;
  head: string;
  body: string;
  submitted_at: string;
}

export interface ConversationComment {
  author: string | null;
  association: string;
  body: string;
  created_at: string;
}

export interface PullRequestContext extends Context {
  threads: Thread[];
  reviews: GatheredReview[];
  lessons: string[];
  conversation: ConversationComment[];
}

interface User {
  login?: string | null;
  type?: string;
}

interface Pull {
  title: string;
  body?: string | null;
  html_url: string;
  user: { login: string };
  base: { ref: string; sha: string };
  head: { sha: string };
}

interface ChangedFile {
  filename: string;
  patch?: string | null;
}

interface ReviewRow {
  user?: User | null;
  state: string;
  commit_id: string;
  body?: string | null;
  submitted_at: string;
}

interface IssueComment {
  user?: User | null;
  author_association: string;
  body?: string | null;
  created_at: string;
}

interface ThreadPage {
  data: { repository: { pullRequest: { reviewThreads: { nodes: ThreadNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } };
}

function field(object: unknown, key: string, fallback: unknown): unknown {
  return object && typeof object === "object" && Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : fallback;
}

function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function shownLines(patch: string | null | undefined): number[] {
  const lines = new Set<number>();
  let current: number | null = null;
  for (const line of splitlines(patch || "")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = Number(header[1]);
    } else if (current !== null && !line.startsWith("-") && !line.startsWith("\\")) {
      lines.add(current);
      current += 1;
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function withoutBot(login: string): string {
  return login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
}

export function isReviewer(login: unknown, reviewerLogin: string): boolean {
  return withoutBot((login as string | null | undefined) || "") === withoutBot(reviewerLogin);
}

export function threadContext(node: ThreadNode, reviewerLogin: string): Thread {
  const comments: ThreadComment[] = node.comments.nodes.map((comment) => ({
    author: field(comment.author, "login", "") as string | null,
    association: comment.authorAssociation,
    is_reviewer: isReviewer(field(comment.author, "login", null), reviewerLogin),
    body: comment.body,
    created_at: comment.createdAt,
  }));
  // The publisher's markers only: one quoted in proof names nothing.
  let kind: string | null = null;
  let name: string | null = null;
  if (comments.length && comments[0]!.is_reviewer) {
    const named = trailingMarkers(comments[0]!.body).filter((marker) => marker[0] !== "state");
    if (named.length) [kind, name] = named.at(-1)!;
  }
  const states = comments
    .filter((comment) => comment.is_reviewer)
    .flatMap((comment) => trailingMarkers(comment.body).filter(([markerKind]) => markerKind === "state").map(([, , state]) => state));
  return {
    node_id: node.id,
    resolved: node.isResolved,
    resolved_by: field(node.resolvedBy, "login", null) as string | null,
    // An outdated thread has no line at the head; its original line still says where it was raised.
    path: node.path,
    line: (field(node, "line", null) || field(node, "originalLine", null)) as number | null,
    kind,
    id: name,
    states,
    // Only the first hundred comments of a thread are gathered. A longer one says so,
    // so the reviewer reads the rest itself.
    cut_short: Boolean(field(node.comments.pageInfo, "hasNextPage", null)),
    root_comment_id: comments.length ? node.comments.nodes[0]!.databaseId : null,
    comments,
  };
}

function origin(url: string): string {
  const cleaned = url.replace(/[\t\r\n]/g, "");
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):([\s\S]*)$/.exec(cleaned);
  const rest = match ? match[2]! : cleaned;
  const netloc = rest.startsWith("//") ? /^\/\/([^/?#]*)/.exec(rest)![1]! : "";
  return `${match ? match[1]!.toLowerCase() : ""}://${netloc}`;
}

export async function gather(github: GitHub, repo: string, number: number, reviewerLogin = "github-actions[bot]"): Promise<PullRequestContext> {
  const pr = (await read(github, `repos/${repo}/pulls/${number}`)) as Pull;
  const files = (await github.paginate(`repos/${repo}/pulls/${number}/files?per_page=100`)) as ChangedFile[];
  const slash = repo.indexOf("/");
  if (slash < 0) throw new Error(`A repository is owner/name, not ${repo}`);
  const [owner, name] = [repo.slice(0, slash), repo.slice(slash + 1)];
  const threads: Thread[] = [];
  let cursor: string | null = null;
  while (true) {
    const data = (await read(github, "graphql", {
      query: THREAD_QUERY,
      variables: { owner, name, number, cursor },
    })) as ThreadPage;
    const page = data.data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes.map((node) => threadContext(node, reviewerLogin)));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  const reviews = (await github.paginate(`repos/${repo}/pulls/${number}/reviews`)) as ReviewRow[];
  const conversation = (await github.paginate(`repos/${repo}/issues/${number}/comments`)) as IssueComment[];
  // The reviewer's login is shared with other automation, so only the publisher's marker names a lesson comment.
  const lessons = conversation
    .filter(
      (comment) =>
        isReviewer(field(comment.user, "login", null), reviewerLogin) &&
        trailingMarkers(field(comment, "body", null) as string | null).some(([kind]) => kind === "lesson"),
    )
    .map((comment) => comment.body as string);
  return {
    repo,
    server_url: origin(pr.html_url),
    number,
    title: pr.title,
    description: pr.body || "",
    author: pr.user.login,
    base_ref: pr.base.ref,
    base_sha: pr.base.sha,
    head_sha: pr.head.sha,
    shown: Object.fromEntries(files.map((file) => [file.filename, shownLines(field(file, "patch", null) as string | null)])),
    threads,
    reviews: reviews
      .filter((review) => isReviewer(field(review.user, "login", null), reviewerLogin) && strip(review.body || ""))
      .map((review) => ({ state: review.state, head: review.commit_id, body: review.body as string, submitted_at: review.submitted_at })),
    lessons,
    conversation: conversation
      .filter((comment) => !isReviewer(field(comment.user, "login", null), reviewerLogin) && field(comment.user, "type", null) !== "Bot")
      .map((comment) => ({
        author: field(comment.user, "login", "") as string | null,
        association: comment.author_association,
        body: comment.body as string,
        created_at: comment.created_at,
      })),
  };
}

function text(value: unknown): string {
  return value === null || value === undefined ? "None" : String(value);
}

export function brief(context: PullRequestContext): string {
  const parts = [
    `# Pull request #${context.number}: ${context.title}`,
    `Author ${context.author} · base \`${context.base_ref}\` at \`${context.base_sha.slice(0, 9)}\` · head \`${context.head_sha.slice(0, 9)}\``,
    "## Description",
    strip(context.description) ? context.description : "(none)",
  ];
  if (context.threads.length) {
    parts.push("## Threads");
    for (const thread of context.threads) {
      const label = thread.kind ? `${thread.kind} \`${thread.id}\`` : "thread";
      let state = "open";
      if (thread.resolved) state = thread.resolved_by ? `resolved by ${thread.resolved_by}` : "resolved";
      parts.push(`### ${label} · ${state} · ${thread.path}:${text(thread.line)}`);
      for (const comment of thread.comments ?? []) {
        const author = comment.is_reviewer ? "reviewer" : `${text(comment.author)} (${comment.association})`;
        parts.push(`**${author}**:`, comment.body);
      }
      if (thread.cut_short) {
        const count = (thread.comments ?? []).length;
        parts.push(
          `_This thread has more than ${count} comments and only the first ` +
            `${count} are shown. Read the rest with \`gh api graphql\` before you judge it._`,
        );
      }
    }
  }
  if (context.reviews.length) {
    parts.push("## Earlier reviews");
    for (const review of context.reviews) parts.push(`### ${review.state} at \`${review.head.slice(0, 9)}\``, review.body);
  }
  if (context.lessons.length) {
    parts.push("## Lessons already proposed");
    parts.push(...context.lessons);
  }
  if (context.conversation.length) {
    parts.push("## Conversation");
    for (const comment of context.conversation) parts.push(`**${text(comment.author)} (${comment.association})**:`, comment.body);
  }
  return parts.join("\n\n") + "\n";
}

/** Put text before the markers that end a review body, and more markers among them. */
export function beforeTrailer(body: string, addition: string, markers: string[] = []): string {
  body = rstrip(body) + "\n";
  const trailer = TRAILER.exec(body);
  const start = trailer ? trailer.index : body.length;
  const parts = [rstrip(body.slice(0, start)), addition, markers.join("\n"), strip(body.slice(start))];
  return parts.filter((part) => part).join("\n\n");
}

const SUGGESTION_FENCE = new RegExp(`(?<=^|\\n)(\`{3,})suggestion[${WHITESPACE.replace("\\n", "")}]*(?=\\n|$)`, "g");

export function plainSuggestions(body: string): string {
  return body.replace(SUGGESTION_FENCE, "$1");
}

export interface ReviewPayload {
  commit_id: string;
  event: string;
  body: string;
  comments: InlineComment[];
}

export function moveComments(payload: ReviewPayload, repo: string, serverUrl: string): void {
  const context = { repo, server_url: serverUrl, head_sha: payload.commit_id };
  const sections = payload.comments.map((comment) => "---\n\n" + placeLabel(comment, context) + "\n\n" + plainSuggestions(comment.body));
  // Each moved finding is named at the end of the body, open, as one published there is.
  const markers = payload.comments.flatMap((comment) =>
    trailingMarkers(comment.body).flatMap(([kind, name]) => [`<!-- review:${kind} ${name} -->`, `<!-- review:state ${name} open -->`]),
  );
  payload.body = beforeTrailer(payload.body, sections.join("\n\n"), markers);
  payload.comments = [];
}

export function threadMutation(reply: Reply): { query: string; variables: { id: string } } {
  const operation = reply.resolve ? "resolveReviewThread" : "unresolveReviewThread";
  return {
    query: `mutation($id: ID!) { ${operation}(input: {threadId: $id}) { thread { id } } }`,
    variables: { id: reply.thread_node_id },
  };
}

export function statusPayload(status: Plan["status"], environ: NodeJS.ProcessEnv): Record<string, string> {
  const payload: Record<string, string> = { ...status };
  if (["GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"].every((name) => environ[name])) {
    payload.target_url =
      `${environ.GITHUB_SERVER_URL!.replace(/\/+$/, "")}/${environ.GITHUB_REPOSITORY}` + `/actions/runs/${environ.GITHUB_RUN_ID}`;
  }
  return payload;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function dumps(value: unknown, ensureAscii = true): string {
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(", ")}]`;
    if (item && typeof item === "object") {
      const entries = Object.entries(item).filter(([, child]) => child !== undefined);
      return `{${entries.map(([key, child]) => `${encode(key)}: ${encode(child)}`).join(", ")}}`;
    }
    const json = JSON.stringify(item) ?? "null";
    return ensureAscii ? json.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : json;
  };
  return encode(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function send(github: GitHub, method: string, path: string, payload: unknown, dryRun: boolean, emit: (line: string) => void): Promise<boolean> {
  if (dryRun) {
    emit(dumps({ method, path, payload }, false));
    return true;
  }
  const response = await github.request(method, path, payload);
  if (!response.ok) throw new Error(response.text);
  if (path === "graphql" && strip(response.text)) {
    const data = JSON.parse(response.text) as unknown;
    const errors = field(data, "errors", null);
    if (truthy(errors)) throw new Error(dumps(errors));
  }
  return true;
}

export interface PublishOptions {
  dryRun?: boolean;
  environ?: NodeJS.ProcessEnv;
  emit?: (line: string) => void;
}

export async function publish(
  github: GitHub,
  repo: string,
  number: number,
  plan: Plan,
  { dryRun = false, environ = process.env, emit = console.log }: PublishOptions = {},
): Promise<number> {
  const payload: ReviewPayload = { commit_id: plan.commit_id, event: plan.event, body: plan.body, comments: plan.comments };
  const path = `repos/${repo}/pulls/${number}/reviews`;
  let approvalFallback = false;
  let inlineFallback = false;
  while (true) {
    try {
      await send(github, "POST", path, payload, dryRun, emit);
      break;
    } catch (error) {
      if (payload.event === "APPROVE" && !approvalFallback) {
        approvalFallback = true;
        payload.event = "COMMENT";
        payload.body = beforeTrailer(payload.body, "GitHub refused the approval, so it is recorded here as a comment.");
      } else if (payload.comments.length && !inlineFallback) {
        inlineFallback = true;
        moveComments(payload, repo, environ.GITHUB_SERVER_URL || "https://github.com");
      } else {
        emit(message(error));
        emit("::error::The review could not be submitted.");
        return 1;
      }
    }
  }
  if (plan.lessons) {
    try {
      await send(github, "POST", `repos/${repo}/issues/${number}/comments`, { body: plan.lessons }, dryRun, emit);
    } catch (error) {
      emit(`::warning::Could not publish the proposed concepts: ${message(error)}`);
    }
  }
  let repliesSent = 0;
  for (const reply of plan.replies) {
    try {
      if (reply.body) {  // null: the words were said earlier and only the resolving is owed
        await send(github, "POST", `repos/${repo}/pulls/${number}/comments/${reply.root_comment_id}/replies`, { body: reply.body }, dryRun, emit);
        repliesSent += 1;
      }
      if (reply.resolve || reply.unresolve) {
        await send(github, "POST", "graphql", threadMutation(reply), dryRun, emit);
      }
    } catch (error) {
      emit(`::warning::Could not finish reply in thread ${reply.thread_node_id}: ${message(error)}`);
    }
  }
  try {
    await send(github, "POST", `repos/${repo}/statuses/${plan.commit_id}`, statusPayload(plan.status, environ), dryRun, emit);
  } catch (error) {
    emit(`::warning::Could not publish review status: ${message(error)}`);
  }
  emit(`${plan.verdict} · ${payload.event} · ${payload.comments.length} comments · ${repliesSent} replies`);
  return 0;
}

const COMMANDS = {
  gather: {
    options: { repo: { type: "string" }, pr: { type: "string" }, out: { type: "string" }, brief: { type: "string" }, "reviewer-login": { type: "string" } },
    required: ["repo", "pr", "out", "brief"],
  },
  publish: {
    options: { repo: { type: "string" }, pr: { type: "string" }, plan: { type: "string" }, "dry-run": { type: "boolean" } },
    required: ["repo", "pr", "plan"],
  },
} as const;

export async function main(argv: string[], io: Io & { github: GitHub }): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.emit("error: the following arguments are required: command");
    return 2;
  }
  if (command !== "gather" && command !== "publish") {
    io.emit(`error: argument command: invalid choice: '${command}' (choose from 'gather', 'publish')`);
    return 2;
  }
  const { options, required } = COMMANDS[command];
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: rest, options }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    io.emit(`error: ${message(error)}`);
    return 2;
  }
  const missing = required.filter((name) => values[name] === undefined);
  if (missing.length) {
    io.emit(`error: the following arguments are required: ${missing.map((name) => "--" + name).join(", ")}`);
    return 2;
  }
  const pr = values.pr as string;
  if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(pr)) {
    io.emit(`error: argument --pr: invalid int value: '${pr}'`);
    return 2;
  }
  const number = Number(pr.replaceAll("_", ""));
  const repo = values.repo as string;
  if (command === "gather") {
    const context = await gather(io.github, repo, number, (values["reviewer-login"] as string | undefined) ?? "github-actions[bot]");
    writeFileSync(values.out as string, JSON.stringify(context, null, 2) + "\n", "utf8");
    writeFileSync(values.brief as string, brief(context), "utf8");
    return 0;
  }
  const plan = JSON.parse(readFileSync(values.plan as string, "utf8")) as Plan;
  return publish(io.github, repo, number, plan, { dryRun: Boolean(values["dry-run"]), environ: io.environ, emit: io.emit });
}
