---
description: "The review record — the JSON a reviewer returns as its whole output: the verdict, what it rests on, findings, decisions for a person, what did not sit right, and lessons, with what the publisher adds around each."
tags: ["skill", "code-review", "review-record", "verdict", "finding", "decision", "json", "reference"]
---

# The Review Record

A review is one JSON object. A publisher turns it into the review a reader sees, so the same record reads the same way every time. You supply the substance. The publisher supplies the frame.

## What the publisher adds

Do not write any of these yourself. They would appear twice.

| The publisher adds | From |
|--------------------|------|
| The approval line, and the alert that opens every other verdict | `verdict`, `headline` |
| The alert on each finding: a warning when it blocks, a note when it does not. The alert holds your `point` and nothing else, except "Do you really need this?" before a complexity finding | `blocks`, `asked`, `point` |
| The fold around proof, labelled by how it was established | `proof`, `how` |
| The suggestion block the author can accept | `suggestion` |
| "Rests on", with a link to each concept | `rests_on` |
| The table of what the verdict rests on, the list of what was not checked, and the list of what did not sit right | `basis`, `not_checked`, `spidey_sense` |
| The table of every finding and its state | `findings`, `decisions` |
| The answer table under a decision, and "reply in this thread" | `options` |
| The words that open a reply: "Fixed.", "Withdrawn.", "Declined.", "Open again.", "Decided: …" | `state`, `answer` |
| The head reviewed, the session, and which `rql` served the review | the workflow |
| A comment of their own for the lessons, apart from the review, asking the author to capture each | `lessons` |

A complexity finding whose `point` already begins with bold text is published as written, with no question added. Use that when your own words ask it better: "**Do you really need a fourth?** This change adds the fourth retry helper in this folder."

## The verdict

| `verdict` | Give it when | `headline` |
|-----------|--------------|------------|
| `approve` | Nothing should hold this. Open notes do not hold it | Empty |
| `request_changes` | At least one open finding blocks | What holds the change, in one sentence. With one finding, its point. With several, what they add up to, not the first one again |
| `needs_decision` | Nothing blocks, and a decision is open | The question |
| `undetermined` | You could not establish whether the change is correct | What stopped you |

`undetermined` is an honest verdict, and "nothing should hold this" is a different claim. Never approve what you could not establish.

## What it rests on

`basis` has five rows, one for each question: `works`, `delivers`, `root`, `spirit`, `simple`.

- `result` is `pass`, `fail`, or `unknown`. `how` is `demonstrated`, `reasoned`, or `unchecked`.
- `detail` is one line: what you ran or read, and what it showed. Counts beat adjectives: "36 of 36 pass in the two classes this change edits".
- Every row is established against the code as it is now. A result remembered from an earlier review is `unchecked` until you run it again.
- A `works` pass is `demonstrated` only when the changed behavior was exercised in the running program, wherever that was reasonably possible. With passing tests alone the pass is `reasoned`, and `not_checked` names the live run that was not made.
- A question fails only when an open finding that blocks fails it. A note does not fail a question, and an approval has no failed row.
- A finding fails the one question it most belongs to. One defect that also goes against a concept fails `works`, and names the concept in `rests_on`.
- A change that treats a symptom fails `root`. The path that still reaches the fault is its proof. That path was broken before the change, so the finding does not fail `works`.

`not_checked` lists what bears on the change and was not checked, one short line each: a platform, a benchmark, a live call. Leave out what the repository's own checks run on every change. A line such as "the full suite was not run locally; CI passed" does not belong.

`spidey_sense` lists what does not sit right with you and what you could not answer, one short line each. It needs no proof and changes no verdict. It is what remains after you tried to turn the unease into a finding, a note, or a decision. Give an empty array when you have nothing, which is the usual case.

## Findings

| Field | What goes in |
|-------|--------------|
| `id` | A short kebab-case name for the defect, such as `login-loses-provider-code`. An earlier finding keeps the id its thread carries |
| `state` | `open`, `fixed`, `withdrawn`, or `declined` |
| `blocks` | `true` when the author must act before merge. `false` for a note |
| `asked` | The one question it fails |
| `how` | How you established it |
| `path`, `start_line`, `line` | Where the finding is anchored. See below |
| `point` | The finding in one sentence. A reader may stop here |
| `body` | Why it matters. The code it is about, when that code is not at the anchored lines, with a link to exactly those lines |
| `suggestion` | The exact replacement for lines `start_line` to `line`, when that replacement is the whole fix. Otherwise `null`, and the fix is shown in `body` |
| `proof` | What you ran and what it showed, enough to reproduce the finding from a checkout of the change. A test goes in as a patch, and a command is given in full: never cite a scratch file on your own machine by its path. Say how far you took any fix you propose |
| `rests_on` | The URIs of the concepts or documents the finding rests on. Only those it rests on |
| `reply` | What you say in the finding's thread this time. See "Reviewing again" |

**Anchoring.** A finding is published as a thread on the lines it names, and a thread can only sit on a line the diff shows: a changed line, or the context around one. Anchor each finding to the changed line that causes it. When the defect shows in code the change did not touch, anchor to the changed line that leads there and link the other place in `body`. Set `path` and `line` to `null` only when no changed line fits; the finding is then published in the review's body. `start_line` is `null` for a single line.

**Suggestions.** The author accepts a suggestion with one click, and it replaces exactly the anchored lines. Give one only when accepting it finishes the fix. Write the lines as they will read in the file, each with its indentation, the first line included. A fix that reaches other lines or other files is described in `body`.

## Decisions

| Field | What goes in |
|-------|--------------|
| `id`, `state` | A short name. `open` or `answered` |
| `path`, `line` | The changed line the question concerns, by the same rule as a finding |
| `question` | One question a person can answer in a word or a sentence |
| `context` | A few sentences on what depends on the answer |
| `options` | Each defensible answer, and what it leads to |
| `answer` | When `answered`: what the person decided, in a few words. Otherwise `null` |
| `reply` | What you say in the decision's thread this time. See "Reviewing again" |

## Reviewing again

The record always holds every finding and decision of this change, including those from earlier reviews, each with its state now. Use the id from the thread's marker, `<!-- review:finding <id> -->` or `<!-- review:decision <id> -->`. An earlier finding also keeps its `point`, as it was first written: the table then reads "fixed: the defect". What changed goes in `reply`, which continues the publisher's opening word and does not repeat it.

| What happened | `state` | `reply` |
|---------------|---------|---------|
| The check that showed it passes now | `fixed` | How you confirmed it, in a line. `proof` holds what you ran |
| The author's reason holds, or you were wrong | `withdrawn` | Why, in a line |
| A person declined it, or its thread was resolved with no change to the code it concerns | `declined` | `null`, or one line that records the reason |
| It is still there and nobody has replied | `open` | `null` |
| It is still there and someone replied | `open` | Your answer to the reply |
| A fix came undone | `open` | What brought it back |
| A person answered a decision | `answered`, with `answer` | What the answer leads to, in a line, or `null` |
| Someone replied to a decision without answering it | `open` | The question again, narrower |

## Lessons

A lesson is a concept you propose, for the author to capture. Propose one when a person's answer, or a finding that keeps coming back, is a rule the team will want on the next change.

Each review's lessons are published as one comment on the pull request, so the author is told about them. Your brief lists the lessons already proposed. Do not propose one of those again.

| Field | What goes in |
|-------|--------------|
| `name` | A CamelCase name |
| `category` | `principle`, `wisdom`, `rule`, `shape`, or `knowledge` |
| `invariant` | The rule in one sentence |
| `why` | Why it holds, and what it cost to learn |
| `relevance` | URI globs naming where it applies |
| `tags` | Comma-separated search tags |
| `from` | The id of the finding or decision it came from |

## An example

```json
{
  "verdict": "request_changes",
  "headline": "A refused read names a budget that is refused again.",
  "basis": [
    { "asked": "works", "result": "fail", "how": "demonstrated", "detail": "a read at the advertised 113 tokens is refused and names 174; 3 of 3 scratch tests fail" },
    { "asked": "delivers", "result": "pass", "how": "demonstrated", "detail": "both done criteria of the plan, each exercised" },
    { "asked": "root", "result": "pass", "how": "reasoned", "detail": "the floor is corrected where it is computed, and its two other callers read the same value" },
    { "asked": "spirit", "result": "pass", "how": "reasoned", "detail": "BudgetContract bears on this change and is kept" },
    { "asked": "simple", "result": "pass", "how": "reasoned", "detail": "nothing added beyond the plan" }
  ],
  "not_checked": ["the multi-hour indexing benchmark"],
  "spidey_sense": [],
  "findings": [
    {
      "id": "floor-names-refused-budget",
      "state": "open",
      "blocks": true,
      "asked": "works",
      "how": "demonstrated",
      "path": "src/Floor.cs",
      "start_line": null,
      "line": 42,
      "point": "A refused read names a budget that is refused again.",
      "body": "The cheapest rendering can itself be a refusal, so its price is not a budget that works.",
      "suggestion": "var floor = Price(cheapestDeliverable);",
      "proof": "- read at 10 tokens → \"needs 113\"\n- read at 113 tokens → \"needs 174\"\n\nThe suggestion was applied and run: both reads are served.",
      "rests_on": ["concept:///rule/agent-experience/ActionableErrors.md"],
      "reply": null
    }
  ],
  "decisions": [],
  "lessons": []
}
```
