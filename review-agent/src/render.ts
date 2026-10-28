/** Render a structured review record into a publish plan without external effects. */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Io } from "./io.js";

export const ASKED = ["works", "delivers", "root", "spirit", "simple"] as const;
export const HOW = ["demonstrated", "reasoned", "unchecked"] as const;
export const VERDICTS = ["approve", "needs_decision", "request_changes", "undetermined"] as const;

export type Asked = (typeof ASKED)[number];
export type How = (typeof HOW)[number];
export type Verdict = (typeof VERDICTS)[number];

const LABELS: Record<Asked, string> = {
  works: "Works",
  delivers: "Delivers its intent",
  root: "Fixes the cause, not the symptom",
  spirit: "In the spirit of the repository",
  simple: "No more than it needs",
};
const PROOF_LABELS: Record<How, string> = { demonstrated: "Proof", reasoned: "Reasoned, not run", unchecked: "Not checked" };

export interface Basis {
  asked: Asked;
  result: "pass" | "fail" | "unknown";
  how: How;
  detail: string;
}

export interface Finding {
  id: string;
  state: "open" | "fixed" | "withdrawn" | "declined";
  blocks: boolean;
  asked: Asked;
  how: How;
  path: string | null;
  start_line: number | null;
  line: number | null;
  point: string;
  body: string;
  suggestion: string | null;
  proof: string | null;
  rests_on: string[];
  reply: string | null;
}

export interface Decision {
  id: string;
  state: "open" | "answered";
  path: string | null;
  line: number | null;
  question: string;
  context: string;
  options: { answer: string; leads_to: string }[];
  answer: string | null;
  reply: string | null;
}

export interface Lesson {
  name: string;
  category: "principle" | "wisdom" | "rule" | "shape" | "knowledge";
  invariant: string;
  why: string;
  relevance: string;
  tags: string;
  from: string;
}

export interface ReviewRecord {
  verdict: Verdict;
  headline: string;
  basis: Basis[];
  not_checked: string[];
  spidey_sense: string[];
  findings: Finding[];
  decisions: Decision[];
  lessons: Lesson[];
}

export interface ThreadComment {
  author: string | null;
  association: string;
  is_reviewer: boolean;
  body: string;
  created_at: string;
}

export interface Thread {
  node_id: string;
  resolved: boolean;
  resolved_by?: string | null;
  path: string;
  line: number | null;
  kind: string | null;
  id: string | null;
  states?: string[];
  cut_short?: boolean;
  root_comment_id: number | null;
  comments?: ThreadComment[];
}

export interface EarlierReview {
  state?: string;
  head?: string;
  body?: string | null;
  submitted_at?: string;
}

export interface Context {
  repo: string;
  server_url: string;
  number: number;
  title: string;
  description: string;
  author: string;
  base_ref: string;
  base_sha: string;
  head_sha: string;
  shown: Record<string, number[]>;
  threads: Thread[];
  reviews?: EarlierReview[];
  lessons?: string[];
  conversation?: unknown[];
}

export type Place = Pick<Context, "repo" | "server_url" | "head_sha">;

export interface Sight {
  session: string;
  rql: string;
  model: string;
  run_url: string;
  command?: string;
  impaired?: string[];
}

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
}

export interface Reply {
  root_comment_id: number | null;
  thread_node_id: string;
  body: string | null;
  resolve: boolean;
  unresolve: boolean;
}

export interface Plan {
  verdict: Verdict;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  commit_id: string;
  body: string;
  comments: InlineComment[];
  replies: Reply[];
  lessons: string;
  status: { state: string; context: string; description: string };
}

export type Marker = [kind: string, name: string, state: string];

// Python's whitespace (str.isspace, re's \s), which JavaScript's \s and trim() do not match exactly.
export const WHITESPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_SPACE = new RegExp(`^[${WHITESPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${WHITESPACE}]+$`);
const SPACE_RUNS = new RegExp(`[${WHITESPACE}]+`, "g");

export function rstrip(text: string): string {
  return text.replace(TRAILING_SPACE, "");
}

export function strip(text: string): string {
  return rstrip(text).replace(LEADING_SPACE, "");
}

type Check = (value: unknown) => boolean;

function objectMatches(value: unknown, fields: Record<string, Check>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const expected = Object.keys(fields);
  return (
    keys.length === expected.length &&
    keys.every((key) => Object.hasOwn(fields, key)) &&
    expected.every((key) => fields[key]!((value as Record<string, unknown>)[key]))
  );
}

function string(value: unknown): boolean {
  return typeof value === "string";
}

function optionalString(value: unknown): boolean {
  return value === null || string(value);
}

function optionalInteger(value: unknown): boolean {
  return value === null || Number.isInteger(value);
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every(string);
}

function oneOf(values: readonly string[]): Check {
  return (value) => string(value) && values.includes(value as string);
}

function objects(fields: Record<string, Check>): Check {
  return (value) => Array.isArray(value) && value.every((item) => objectMatches(item, fields));
}

/** Check the schema's keys, types, enums, and additional-property restrictions. */
export function validRecord(record: unknown): record is ReviewRecord {
  return objectMatches(record, {
    verdict: oneOf(VERDICTS),
    headline: string,
    basis: objects({ asked: oneOf(ASKED), result: oneOf(["pass", "fail", "unknown"]), how: oneOf(HOW), detail: string }),
    not_checked: strings,
    spidey_sense: strings,
    findings: objects({
      id: string,
      state: oneOf(["open", "fixed", "withdrawn", "declined"]),
      blocks: (value) => typeof value === "boolean",
      asked: oneOf(ASKED),
      how: oneOf(HOW),
      path: optionalString,
      start_line: optionalInteger,
      line: optionalInteger,
      point: string,
      body: string,
      suggestion: optionalString,
      proof: optionalString,
      rests_on: strings,
      reply: optionalString,
    }),
    decisions: objects({
      id: string,
      state: oneOf(["open", "answered"]),
      path: optionalString,
      line: optionalInteger,
      question: string,
      context: string,
      options: objects({ answer: string, leads_to: string }),
      answer: optionalString,
      reply: optionalString,
    }),
    lessons: objects({
      name: string,
      category: oneOf(["principle", "wisdom", "rule", "shape", "knowledge"]),
      invariant: string,
      why: string,
      relevance: string,
      tags: string,
      from: string,
    }),
  });
}

export function present(value: unknown): value is string {
  return typeof value === "string" && strip(value) !== "";
}

export function blocks(...parts: unknown[]): string {
  return parts.filter(present).join("\n\n");
}

export function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? "> " + line : ">"))
    .join("\n");
}

export function fence(code: string, info = ""): string {
  const runs = (code.match(/`+/g) ?? []).map((run) => run.length);
  const ticks = "`".repeat(Math.max(3, 1 + Math.max(0, ...runs)));
  const ending = code.endsWith("\n") ? "" : "\n";
  return `${ticks}${info}\n${code}${ending}${ticks}`;
}

export function cell(text: string): string {
  return strip(text).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

export interface Located {
  path?: string | null;
  start_line?: number | null;
  line?: number | null;
}

function pathOf(item: Located): string | null {
  const path = item.path;
  return present(path) ? (path.startsWith("./") ? path.slice(2) : path) : null;
}

function startOf(item: Located): number | null {
  const start = item.start_line;
  const line = item.line ?? null;
  return Number.isInteger(start) && Number.isInteger(line) && start! < line! ? start! : line;
}

function repoUrl(context: Place): string {
  return `${context.server_url.replace(/\/+$/, "")}/${context.repo}`;
}

function permalink(item: Located, context: Place): string {
  const line = item.line;
  const start = startOf(item);
  const anchor = start === line ? `#L${line}` : `#L${start}-L${line}`;
  return `${repoUrl(context)}/blob/${context.head_sha}/${pathOf(item)}${anchor}`;
}

export function placeLabel(item: Located, context: Place): string {
  const start = startOf(item);
  const line = item.line;
  const lines = start === line ? `line ${line}` : `lines ${start}–${line}`;
  return `[\`${pathOf(item)!.split("/").at(-1)}\`, ${lines}](${permalink(item, context)})`;
}

function urlPath(uri: string): string {
  return /^[^:/?#]+:\/\/[^/?#]*([^?#]*)/.exec(uri.replace(/[\t\r\n]/g, ""))?.[1] ?? "";
}

function restsOn(uris: string[], context: Place): string {
  const links: string[] = [];
  const base = `${repoUrl(context)}/blob/${context.head_sha}`;
  for (const uri of uris) {
    if (!present(uri)) continue;
    if (uri.startsWith("concept:///")) {
      const path = uri.slice("concept:///".length);
      const last = path.split("/").at(-1)!;
      const name = last.endsWith(".md") ? last.slice(0, -".md".length) : last;
      links.push(`[${name}](${base}/.repoql/concepts/${path})`);
    } else if (uri.startsWith("file:///")) {
      const path = uri.slice("file:///".length).split("#")[0]!;
      links.push(`[\`${path.split("/").at(-1)}\`](${base}/${path})`);
    } else if (uri.startsWith("http://") || uri.startsWith("https://")) {
      const name = urlPath(uri).replace(/\/+$/, "").split("/").at(-1);
      links.push(`[${name}](${uri})`);
    } else {
      links.push(`\`${uri}\``);
    }
  }
  return links.length ? "Rests on " + links.join(", ") + "." : "";
}

function details(label: string, content: string): string {
  return `<details><summary>${label}</summary>\n\n${content}\n\n</details>`;
}

function proof(item: { how: How; proof: string | null }): string {
  return present(item.proof) ? details(PROOF_LABELS[item.how], item.proof) : "";
}

function alert(kind: string, text: string): string {
  return `> [!${kind}]\n${quote(text)}`;
}

function withReply(sentence: string, reply: string | null): string {
  return sentence + (present(reply) ? " " + reply : "");
}

/** acceptable: the comment sits on exactly the lines the suggestion replaces. */
function findingBody(item: Finding, context: Place, inline: boolean, acceptable: boolean): string {
  // The alert says whether it blocks. Only the complexity gate has words of its own to add.
  let point = item.point;
  if (item.blocks && item.asked === "simple" && !point.startsWith("**")) {
    point = withReply("**Do you really need this?**", point);
  }
  let suggestion = "";
  if (present(item.suggestion)) {
    suggestion = acceptable ? fence(item.suggestion, "suggestion") : "Suggested change:\n" + fence(item.suggestion);
  }
  const location = !inline && pathOf(item) && item.line !== null ? permalink(item, context) : "";
  return blocks(
    alert(item.blocks ? "WARNING" : "NOTE", point),
    location,
    item.body,
    restsOn(item.rests_on, context),
    suggestion,
    proof(item),
    `<!-- review:finding ${item.id} -->`,
  );
}

function decisionBody(item: Decision, context: Place, inline: boolean): string {
  let options = "";
  if (item.options.length) {
    options = [
      "| Answer | Leads to |",
      "|---|---|",
      ...item.options.map((option) => `| **${cell(option.answer)}** | ${cell(option.leads_to)} |`),
    ].join("\n");
  }
  const location = !inline && pathOf(item) && item.line !== null ? permalink(item, context) : "";
  return blocks(
    alert("IMPORTANT", withReply("**A decision for a person.**", item.question)),
    location,
    item.context,
    options,
    inline ? "Reply in this thread with your answer." : "Reply on this pull request with your answer.",
    `<!-- review:decision ${item.id} -->`,
  );
}

// Python's multiline ^ and $ match only at a line feed, where JavaScript's m flag also matches at \r, \u2028
// and \u2029, so the line boundaries are spelled out.
export const MARKER = new RegExp(
  `(?<=^|\\n)<!-- review:(finding|decision|state|lesson) ([^${WHITESPACE}]+)(?: ([^${WHITESPACE}]+))? -->[ \\t]*(?=\\n|$)`,
  "g",
);
export const TRAILER = new RegExp(`(?:(?<=^|\\n)<!-- review:[^\\n]*-->[${WHITESPACE}]*)+$`);

/**
 * The markers that end a published text, as [kind, id, state] in order.
 *
 * The publisher writes its markers last, after everything a reviewer wrote. Only
 * those are read back, so a marker quoted as evidence, in any kind of code block
 * or none, is never mistaken for one.
 */
export function trailingMarkers(text: string | null | undefined): Marker[] {
  const trailer = TRAILER.exec(rstrip((text || "").replaceAll("\r\n", "\n")) + "\n");
  return trailer ? [...trailer[0].matchAll(MARKER)].map((match) => [match[1]!, match[2]!, match[3] ?? ""]) : [];
}

function namedMarker(kind: string, item: { id: string }): string {
  return `<!-- review:${kind} ${item.id} -->`;
}

function stateMarker(item: { id: string; state: string }): string {
  return `<!-- review:state ${item.id} ${item.state} -->`;
}

/** What the reviewer says when a finding or a decision stops being open. */
function closingWords(kind: "finding" | "decision", item: Finding | Decision): string {
  if (kind === "decision") {
    const answer = (item as Decision).answer;
    const sentence = present(answer) ? `☑️ **Decided: ${answer}.**` : "☑️ **Decided.**";
    return withReply(sentence, item.reply);
  }
  const finding = item as Finding;
  const sentence = {
    fixed: "✅ **Fixed.**",
    withdrawn: "↩️ **Withdrawn.**",
    declined: "🤝 **Declined. It will not be raised again.**",
  }[finding.state as "fixed" | "withdrawn" | "declined"];
  return blocks(withReply(sentence, finding.reply), finding.state === "fixed" ? proof(finding) : "");
}

function replyFor(kind: "finding" | "decision", item: Finding | Decision, thread: Thread): Reply | null {
  const state = item.state;
  // Against the latest marker, not any marker: a finding fixed, reopened and
  // fixed again is confirmed again.
  const states = thread.states ?? [];
  const marked = states.length > 0 && states.at(-1) === state;
  let body = "";
  let resolve = false;
  let unresolve = false;
  const marker = stateMarker(item);
  const comments = thread.comments ?? [];
  if (state !== "open") {
    if (!marked) {
      body = blocks(closingWords(kind, item), marker);
      resolve = true;
    } else if (!thread.resolved && comments.length && comments.at(-1)!.is_reviewer) {
      // The closing words were said and the thread is still open with nobody
      // having answered: resolving it failed last time, so only resolve.
      return { root_comment_id: thread.root_comment_id, thread_node_id: thread.node_id, body: null, resolve: true, unresolve: false };
    }
  } else if (kind === "finding" && thread.resolved) {
    body = blocks(withReply("🔴 **Open again.**", item.reply), proof(item as Finding), marker);
    unresolve = true;
  } else if (present(item.reply)) {
    // The reviewer speaks in an open thread only to answer someone. The answer ends
    // with the publisher's marker like everything else, so whatever the reviewer's
    // own words end with, the last marker in the thread is a real one.
    if (comments.length && !comments.at(-1)!.is_reviewer) {
      body = blocks(item.reply, marker);
    }
  }
  if (!body) return null;
  return { root_comment_id: thread.root_comment_id, thread_node_id: thread.node_id, body, resolve, unresolve };
}

function stateGroup(kind: "finding" | "decision", item: Finding | Decision): [number, string] {
  if (item.state === "open") {
    return kind === "decision" ? [1, "❓"] : (item as Finding).blocks ? [0, "🔴"] : [2, "💬"];
  }
  return { fixed: [3, "✅"], answered: [4, "☑️"], withdrawn: [5, "↩️"], declined: [6, "🤝"] }[item.state] as [number, string];
}

type Item = Omit<Finding, "state"> & Omit<Decision, "state"> & { state: Finding["state"] | Decision["state"] };

interface Routed {
  comments: InlineComment[];
  replies: Reply[];
  sections: string[];
  closures: string[];
  trailer: string[];
  table: string;
  rowCount: number;
}

function routeItems(record: ReviewRecord, context: Context): Routed {
  const comments: InlineComment[] = [];
  const replies: Reply[] = [];
  const sections: string[] = [];
  const closures: string[] = [];
  const trailer: string[] = [];
  const rows: [number, string][] = [];
  const replied = new Set<string>();
  // What an earlier review published in its body has no thread to answer in.
  // Its outcome is still owed: a row, and once, the words a thread would get.
  const earlier = (context.reviews ?? []).flatMap((review) => trailingMarkers(review.body));
  const inEarlierBodies = new Set(earlier.filter(([kind]) => kind !== "state").map(([kind, name]) => `${kind} ${name}`));
  const lastSaid = new Map(earlier.filter(([kind]) => kind === "state").map(([, name, state]) => [name, state]));
  const groups: ["finding" | "decision", (Finding | Decision)[]][] = [
    ["finding", record.findings],
    ["decision", record.decisions],
  ];
  for (const [kind, items] of groups) {
    for (const original of items) {
      const item = { ...original, path: pathOf(original) } as Item;
      const thread = context.threads.find((t) => t.kind === kind && t.id === item.id);
      let where: string;
      if (thread === undefined && item.state !== "open") {
        if (!inEarlierBodies.has(`${kind} ${item.id}`)) continue;
        where = "an earlier review";
        if (lastSaid.get(item.id) !== item.state) {
          closures.push(blocks(quote(kind === "finding" ? item.point : item.question), closingWords(kind, item)));
          trailer.push(stateMarker(item));
        }
      } else if (thread) {
        const reply = replyFor(kind, item, thread);
        if (reply && !replied.has(thread.node_id)) {
          replies.push(reply);
          replied.add(thread.node_id);
        }
        where = `[thread](${repoUrl(context)}/pull/${context.number}#discussion_r${thread.root_comment_id})`;
      } else {
        const shown = new Set(item.path !== null && Object.hasOwn(context.shown, item.path) ? context.shown[item.path] : []);
        const inline = Boolean(item.path) && item.line !== null && shown.has(item.line);
        let body: string;
        if (kind === "decision") {
          body = decisionBody(item as Decision, context, inline);
        } else {
          // GitHub takes a range only inside one hunk, and a suggestion replaces
          // exactly the commented lines: a range the diff does not show whole
          // becomes a comment on its last line, with the fix shown and not offered.
          let whole = inline;
          for (let n = startOf(item)!; whole && n < item.line! + 1; n++) whole = shown.has(n);
          if (inline && !whole) item.start_line = null;
          body = findingBody(item as Finding, context, inline, whole);
        }
        if (inline) {
          const comment: InlineComment = { path: item.path!, line: item.line!, side: "RIGHT", body };
          if (kind === "finding" && startOf(item) !== item.line) {
            Object.assign(comment, { start_line: startOf(item)!, start_side: "RIGHT" });
          }
          comments.push(comment);
          where = placeLabel(item, context);
        } else {
          sections.push(body);
          // Named again at the end of the body, with its state: that is where the
          // next review looks, so a fix is announced, and announced again if the
          // finding comes back.
          trailer.push(namedMarker(kind, item), stateMarker(item));
          where = "below";
        }
      }
      const [group, icon] = stateGroup(kind, item);
      const text = kind === "finding" ? item.point : item.question;
      rows.push([group, `| ${icon} | ${cell(text)} | ${cell(where)} |`]);
    }
  }
  const table = rows.length
    ? ["| | What | Where |", "|---|---|---|", ...rows.sort((a, b) => a[0] - b[0]).map(([, row]) => row)].join("\n")
    : "";
  return { comments, replies, sections, closures, trailer, table, rowCount: rows.length };
}

function basisTable(record: ReviewRecord): string {
  const rows: string[] = [];
  for (const asked of ASKED) {
    for (const row of record.basis) {
      if (row.asked === asked) {
        const icon = { pass: "✅", fail: "❌", unknown: "❔" }[row.result];
        rows.push(`| ${icon} | ${LABELS[asked]} | ${row.how} | ${cell(row.detail)} |`);
      }
    }
  }
  rows.push(...record.not_checked.map((detail) => `| ⚪ | Not checked | | ${cell(detail)} |`));
  rows.push(...record.spidey_sense.map((detail) => `| 🕷️ | Spidey sense | | ${cell(detail)} |`));
  return rows.length ? ["| | Asked | Basis | Detail |", "|---|---|---|---|", ...rows].join("\n") : "";
}

const SESSION_WORDS: Record<string, string> = {
  continued: "continued",
  new: "new",
  fresh: "new, on request",
  lost: "new: the earlier one could not be restored",
};

function sightLine(context: Context, sight: Sight, stated: string | null, effective: string): string {
  if (!Object.hasOwn(SESSION_WORDS, sight.session)) throw new Error(`Unknown session: ${sight.session}`);
  const words = SESSION_WORDS[sight.session];
  const command = Object.hasOwn(sight, "command") ? sight.command : "/codex-review";
  let text =
    `<sub>Reviewed \`${context.head_sha.slice(0, 9)}\` · session ${words} · rql ${sight.rql} · ` +
    `${sight.model} · [run](${sight.run_url}) · comment \`${command} fresh\` ` +
    "for a second opinion";
  if (stated !== null && stated !== effective) {
    text += ` · verdict stated as ${stated}, published as ${effective}`;
  }
  return text + "</sub>";
}

function effectiveVerdict(record: ReviewRecord): Verdict {
  const stated = record.verdict;
  if (stated === "undetermined") return stated;
  let derived: Verdict = "approve";
  if (record.decisions.some((item) => item.state === "open")) derived = "needs_decision";
  if (record.findings.some((item) => item.state === "open" && item.blocks)) derived = "request_changes";
  return VERDICTS.indexOf(derived) > VERDICTS.indexOf(stated) ? derived : stated;
}

function lessonBody(lesson: Lesson): string {
  const attribution = [
    `\`${lesson.category}\``,
    present(lesson.relevance) ? `applies to \`${lesson.relevance}\`` : "",
    present(lesson.tags) ? `tags: ${lesson.tags}` : "",
    present(lesson.from) ? `from \`${lesson.from}\`` : "",
  ]
    .filter((part) => part)
    .join(" · ");
  return blocks(`### 💡 ${lesson.name}`, quote(lesson.invariant), lesson.why, attribution);
}

/** The lessons as a comment of their own, which reaches the author as a review body's fold does not. */
function lessonsComment(lessons: Lesson[], context: Context): string {
  if (!lessons.length) return "";
  const one = lessons.length === 1;
  const opening =
    `**Worth capturing as ${one ? "a concept" : "concepts"}.** The review of ` +
    `\`${context.head_sha.slice(0, 9)}\` surfaced ${one ? "a rule" : "rules"} the team will want again. ` +
    `Capture ${one ? "it" : "each"} with \`capture_concept\` in this pull request.`;
  const markers = lessons.map((lesson) => `<!-- review:lesson ${lesson.name.replace(SPACE_RUNS, "") || "unnamed"} -->`).join("\n");
  return blocks(alert("TIP", opening), ...lessons.map(lessonBody), markers);
}

/** Return a publish plan; unusable records retain their raw message as evidence. */
export function render(record: unknown, context: Context, sight: Sight, raw = ""): Plan {
  const valid = validRecord(record);
  const verdict = valid ? effectiveVerdict(record) : "undetermined";
  const stated = valid ? record.verdict : null;
  const sightText = sightLine(context, sight, stated, verdict);
  const parts = (sight.impaired ?? []).filter(present).map((text) => alert("CAUTION", text));
  let comments: InlineComment[] = [];
  let replies: Reply[] = [];
  if (!valid) {
    parts.push(
      alert(
        "CAUTION",
        "**Could not establish whether this change is correct.** " +
          "The reviewer did not return a structured review. Its final message is below.",
      ),
      details("The reviewer's final message", fence(raw)),
      details("What this review stands on", sightText),
    );
  } else {
    const routed = routeItems(record, context);
    ({ comments, replies } = routed);
    const { sections, closures, trailer, table, rowCount } = routed;
    const basis = basisTable(record);
    if (verdict === "approve") {
      parts.push(details("LGTM :shipit:", blocks(basis, table, ...closures, sightText)));
      parts.push(...sections.map((section) => blocks("---", section)));
    } else {
      const [kind, sentence] = {
        request_changes: ["WARNING", "**Changes requested.**"],
        needs_decision: ["IMPORTANT", "**A decision for a person.**"],
        undetermined: ["CAUTION", "**Could not establish whether this change is correct.**"],
      }[verdict] as [string, string];
      parts.push(alert(kind, withReply(sentence, record.headline)));
      if (rowCount >= 2) parts.push(table);
      parts.push(...sections.map((section) => blocks("---", section)));
      parts.push(blocks(sections.length ? "---" : "", details("What this review stands on", blocks(basis, ...closures, sightText))));
    }
    parts.push(trailer.join("\n"));
  }
  parts.push(`<!-- review:record head=${context.head_sha} session=${sight.session} -->`);
  const blocking = valid ? record.findings.filter((item) => item.state === "open" && item.blocks).length : 0;
  const changes = blocking ? (blocking === 1 ? "1 finding blocks" : `${blocking} findings block`) : "Changes requested";
  const [event, state, description] = {
    approve: ["APPROVE", "success", "Nothing should hold this"],
    request_changes: ["REQUEST_CHANGES", "failure", changes],
    needs_decision: ["COMMENT", "pending", "Waiting on a decision from a person"],
    undetermined: ["COMMENT", "failure", "Could not establish whether this is correct"],
  }[verdict] as [Plan["event"], string, string];
  return {
    verdict,
    event,
    commit_id: context.head_sha,
    body: blocks(...parts),
    comments,
    replies,
    lessons: valid ? lessonsComment(record.lessons, context) : "",
    status: { state, context: "review/verdict", description },
  };
}

export function markdown(plan: Plan): string {
  const parts = [plan.body];
  for (const comment of plan.comments) {
    const start = Object.hasOwn(comment, "start_line") ? comment.start_line : comment.line;
    parts.push(`--- inline comment on ${comment.path}:${start}-${comment.line} ---`, comment.body);
  }
  for (const reply of plan.replies) {
    if (reply.body) parts.push(`--- reply in thread ${reply.root_comment_id} ---`, reply.body);
  }
  if (plan.lessons) parts.push("--- comment on the pull request ---", plan.lessons);
  return blocks(...parts);
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      record: { type: "string" },
      raw: { type: "string" },
      context: { type: "string" },
      sight: { type: "string" },
      out: { type: "string" },
      markdown: { type: "boolean" },
    },
  }).values;
}

export async function main(argv: string[], io: Io): Promise<number> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(argv);
  } catch (error) {
    io.emit(`error: ${(error as Error).message}`);
    return 2;
  }
  if (values.out !== undefined && values.markdown) {
    io.emit("error: argument --markdown: not allowed with argument --out");
    return 2;
  }
  const missing = (["context", "sight"] as const).filter((name) => values[name] === undefined);
  if (missing.length) {
    io.emit(`error: the following arguments are required: ${missing.map((name) => "--" + name).join(", ")}`);
    return 2;
  }
  if (values.out === undefined && !values.markdown) {
    io.emit("error: one of the arguments --out --markdown is required");
    return 2;
  }
  let raw = values.raw ? readFileSync(values.raw, "utf8") : "";
  let record: unknown = null;
  if (values.record) {
    try {
      const text = readFileSync(values.record, "utf8");
      if (!values.raw) raw = text;
      record = JSON.parse(text);
    } catch {
      record = null;
    }
  }
  const context = JSON.parse(readFileSync(values.context!, "utf8")) as Context;
  const sight = JSON.parse(readFileSync(values.sight!, "utf8")) as Sight;
  const plan = render(record, context, sight, raw);
  if (values.markdown) {
    io.emit(markdown(plan));
  } else {
    writeFileSync(values.out!, JSON.stringify(plan, null, 2) + "\n", "utf8");
  }
  return 0;
}
