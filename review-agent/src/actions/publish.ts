/**
 * The publish, reply and archive actions: the steps that write to GitHub or forget a session, and run none of the
 * change's code.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";

import { type GitHub, githubFromEnvironment, read } from "../github-client.js";
import { opensDecision } from "../job.js";
import { publish as publishPlan } from "../pull-request.js";
import { adapterName, eventPayload, repository, runUrl } from "./common.js";
import { adapterFor } from "./review.js";

/** One comment naming the step that failed, and the verdict status in error, so an earlier verdict on the same head does not stand. */
async function sayNoReview(github: GitHub, pr: string, headSha: string, environ: NodeJS.ProcessEnv): Promise<void> {
  const repo = repository(environ).full;
  const url = runUrl(environ);
  let step = "";
  try {
    const jobs = (await github.paginate(`repos/${repo}/actions/runs/${environ.GITHUB_RUN_ID}/attempts/${environ.GITHUB_RUN_ATTEMPT || "1"}/jobs`, "jobs")) as {
      steps?: { name: string; conclusion: string | null }[];
    }[];
    step = jobs.flatMap((job) => job.steps ?? []).find((s) => s.conclusion === "failure")?.name ?? "";
  } catch {
    step = "";
  }
  const reason = step ? `The step "${step}" failed.` : "A step failed before the reviewer finished.";
  const comment = await github.request("POST", `repos/${repo}/issues/${pr}/comments`, {
    body: `> [!CAUTION]\n> **No review was made.** ${reason} [Run](${url})`,
  });
  if (!comment.ok) core.warning("Could not comment that no review was made.");
  let head = headSha;
  if (!head) {
    try {
      head = ((await read(github, `repos/${repo}/pulls/${pr}`)) as { head: { sha: string } }).head.sha;
    } catch {
      head = "";
    }
  }
  if (head) {
    const status = await github.request("POST", `repos/${repo}/statuses/${head}`, {
      state: "error", context: "review/verdict", description: "No review was made", target_url: url,
    });
    if (!status.ok) core.warning("Could not set the verdict status to error.");
  }
}

/**
 * The plan as an advisory review: an approval is posted as a comment, so the reviewer never counts toward a merge.
 * The `review/verdict` status still says what the reviewer concluded.
 */
export function withoutApproval<T extends { event: string }>(plan: T): T {
  return plan.event === "APPROVE" ? { ...plan, event: "COMMENT" } : plan;
}

export async function publish(environ: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pr = core.getInput("pr", { required: true });
  const result = core.getInput("review-result", { required: true });
  const github = githubFromEnvironment(environ, core.getInput("token"));
  const repo = repository(environ).full;
  if (result !== "success") {
    await sayNoReview(github, pr, core.getInput("head-sha"), environ);
    return;
  }
  try {
    const name = core.getInput("artifact") || `review-${pr}-${environ.GITHUB_RUN_ATTEMPT || "1"}`;
    const client = new DefaultArtifactClient();
    const { artifact } = await client.getArtifact(name);
    const into = join(environ.RUNNER_TEMP ?? "/tmp", "handoff");
    await client.downloadArtifact(artifact.id, { path: into });
    const planned = JSON.parse(readFileSync(join(into, "plan.json"), "utf8"));
    const plan = core.getInput("approve") === "false" ? withoutApproval(planned) : planned;
    const code = await publishPlan(github, repo, Number(pr), plan, { environ, emit: (line: string) => core.info(line) });
    if (code !== 0) throw new Error(`Publishing the review exited ${code}.`);
  } catch (error) {
    await sayNoReview(github, pr, core.getInput("head-sha"), environ);
    throw error;
  }
}

/**
 * Start a review when a person replies in a thread the reviewer opened as a decision, so their answer is applied.
 * Any other reply starts nothing.
 */
export async function reply(environ: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = eventPayload(environ);
  const root = event.comment?.in_reply_to_id;
  if (environ.GITHUB_EVENT_NAME !== "pull_request_review_comment" || !root) {
    core.info("Not a reply in a review thread; nothing to do.");
    core.setOutput("started", "false");
    return;
  }
  const github = githubFromEnvironment(environ, core.getInput("token"));
  const repo = repository(environ).full;
  const comment = (await read(github, `repos/${repo}/pulls/comments/${root}`)) as { body?: string };
  // Read only from the markers the publisher wrote last, so a marker quoted in a reviewer's proof is never mistaken for one.
  if (!opensDecision(comment.body ?? "")) {
    core.info("The reply is not in a decision thread; nothing to do.");
    core.setOutput("started", "false");
    return;
  }
  const pr = String(event.pull_request?.number ?? "");
  const workflow = core.getInput("workflow", { required: true });
  const ref = core.getInput("ref") || event.repository?.default_branch || "main";
  const started = await github.request("POST", `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    ref,
    inputs: { pr },
  });
  if (!started.ok) throw new Error(`The review workflow ${workflow} could not be started: ${started.status} ${started.text}`);
  core.info(`The reply is in a decision thread; started a review of #${pr}.`);
  core.setOutput("started", "true");
}

/** Forget a closed pull request's session: its record and transcript on the runner, and its session artifacts. */
export async function archive(environ: NodeJS.ProcessEnv = process.env): Promise<void> {
  const agent = core.getInput("agent") || "claude";
  const pr = core.getInput("pr", { required: true });
  const repo = repository(environ).full;
  try {
    await adapterFor(agent, environ.REVIEW_WORKSPACE || environ.GITHUB_WORKSPACE || process.cwd()).archive(repo, Number(pr));
  } catch (error) {
    core.warning(`Nothing on the runner was archived: ${String(error)}`);
  }
  if ((core.getInput("session-store") || "artifact") !== "artifact") return;
  const github = githubFromEnvironment(environ, core.getInput("token"));
  const name = `review-session-${adapterName(agent)}-${pr}`;
  const artifacts = (await github.paginate(`repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`, "artifacts")) as { id: number }[];
  let deleted = 0;
  for (const { id } of artifacts) {
    const response = await github.request("DELETE", `repos/${repo}/actions/artifacts/${id}`);
    if (response.ok) deleted += 1;
    else core.warning(`Could not delete artifact ${id}.`);
  }
  core.info(`Deleted ${deleted} session artifact(s) for #${pr}.`);
}
