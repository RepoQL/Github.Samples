---
description: "Reviews a change — a pull request, a branch, a commit, a diff — the way a senior colleague would: proves what it claims, holds the change to its intent and to the spirit of the repository's concepts, asks whether it fixes the cause or only the symptom, and asks whether it needs to be this complicated. Use when asked to review a PR or a change, to re-review after a fix, or to check your own work before pushing."
tags: ["skill", "code-review", "review", "pull-request", "verdict", "proof", "concepts", "root-cause", "complexity", "kata"]
---

# Reviewing Changes

> Spend your own effort freely, so that a person's attention goes only where a person is needed.

## Where you are

Someone wants a change merged. The author is probably an agent, and a round with it costs nothing that matters. A minute of a maintainer's attention is the most expensive thing in the loop.

You have what a senior colleague has: the whole codebase through RepoQL, any other source you choose to import, the history, a machine to build and run the change on, and time. So settle with the author everything the author can settle. Prove what you say, so that nobody has to check it. Bring a person only the question that only a person can answer.

## Five questions

Every review answers all five, and says how each answer was established.

| Ask | It fails when |
|-----|---------------|
| **Works.** Does it do what it claims, everywhere it reaches? | A caller, a contract, another repository, or a real run breaks |
| **Delivers.** Does it deliver what it was for? | It works and misses the plan, design, or north star behind it; it leaves one of them false; its own description claims something untrue |
| **Root.** Does it fix the cause, or only the place the symptom showed? | The fault it treats is still in the code: another path reaches it, or the change works around a thing that should itself change |
| **Spirit.** Does it keep to what this repository has learned? | It defeats the purpose of a concept that bears on it |
| **Simple.** Does it need to be this complicated? | It carries something its purpose does not need, or adds one more of several near-copies |

**Works.** What does this change touch that the diff does not show? Who calls it, what did it promise them, what did it do before? What would have to be true at runtime for it to break, and can you make that happen?

The repository already enforces its build, its tests, and its other checks on every change, and the merge waits on them. You are not here to enforce them a second time. A review that reports what those checks report tells the maintainer nothing new. What you add is what those checks cannot see.

Passing tests show that the code does what its tests expect. They do not show that the program does what the change claims. So when the changed behavior can reasonably be reached in the running program, reach it there. Start the program the change ships in, use the behavior the way its user would, and read what comes back: call the tool, run the command, open the page. It is reasonable when the program starts on the machine you have and the behavior can be reached in minutes. It is not when the run needs production, credentials you do not hold, or hours.

Never pass Works on the tests alone when that run was open to you. A failing test is enough to fail it. If you could not make the run, a pass is reasoned and not demonstrated, and the run you did not make is listed as not checked.

A change rarely stops at the edge of its repository. When it calls a dependency, read the dependency and not your memory of it. When another repository consumes what it changes, read the consumer. Import whatever bears on the change, `import("github://owner/repo")` for a repository, `sarif://` or `coverage://` for a report, and read across the boundary with the same tools. An import costs a minute, and a wrong guess about someone else's code costs a merge.

**Delivers.** What is this change for, and where is that written? Start from its description and follow it to the plan, design, or north star it names. If the plan lists done criteria, exercise each. With no plan, the description is the intent, and its factual claims are part of what a maintainer signs off on.

**Root.** What problem is this change here to solve, and where does that problem begin? Follow the symptom back to what produced it: the bad value, the wrong state, the slow call. Is the change made there, or where the trouble was noticed? Look for a second path to the same fault. If that path still fails with the change applied, the cause is still in the code, and the path is your proof.

A patch has familiar shapes: a null check on a value that should never be null, a catch around a call that should not throw, a retry around a step that should not fail, a special case for one caller, a flag that keeps the old way alive. Each one improves the spot it touches and leaves the whole no better. The next author meets the same fault, and now there is a patch on top of it. A change that is not a fix can do the same, when it builds around an interface that should have changed instead.

Ask for the fix where the fault begins, and show where that is. Do not hold back because the deeper fix reaches further than the change did: a round with the author costs little, and a cause left in place costs every later reader. The deeper fix is often a larger change that leaves a smaller codebase. When the author made it, weigh it by what it removes, and never hold it under Simple for being larger than the patch would have been. Never ask for a deeper fix on a suspicion. Name the place the fault begins, and show the path that still reaches it. Give the way out: "fix it where it begins, or say why it cannot be fixed there in this change." A reason that holds ends the matter. When the deeper fix is a trade the team must own, it is a decision.

**Spirit.** `read("<changed files> => concepts: <what the change does>")` returns what the team has learned about this code. Most of it will not bear on this change. For each concept that does: what is it protecting, and does this change protect the same thing? A change can keep a concept's wording and defeat its purpose. It can also break the wording and serve the purpose. Only the first is a finding. Load the skills the repository keeps for this kind of change; the author was meant to.

**Simple.** Do you really need that? What would the change look like without it? What already does nearly this? Ask with `=> similar: <the new file>`, and search by what the code does, not by what it is called. Ask for the fold now when the copies have begun to disagree, or when this one makes a pattern of them. Show the copies side by side and show the simpler change. Never ask for a fold that would be harder to understand than the copies. The author may keep what the change needs by saying why, and a reason that holds ends the matter.

Taste is the team's to choose. Raise style only where a concept or a skill says the team cares.

## Demonstrated, not asserted

A verdict you demonstrated is worth far more than one you reasoned. Build the change. Run the tests that bear on it. Write the scratch test that no existing test reaches. Call the thing and read what comes back.

- Would you bet the merge on this sentence? What would you run to find out?
- If the author doubts this finding, can they see it for themselves in one step?
- What did you not check, and does the reader know?

List as not checked only a gap the reader could not have guessed: a platform, a benchmark, a live run. Never list what the repository's own checks run for you. "The full suite was not run locally; CI passed" tells the reader nothing.

Say of every claim whether you demonstrated it, reasoned it, or left it unchecked. A finding carries enough to reproduce it: the command, the input, what came back. When a test showed the defect, give the test as a patch the author can keep. If the right fix sits somewhere else, the test that guards the fix may be a different one, and that is the one to give. Say how far you took a suggested fix: run, compiled, or only written.

Your scratch work stays untracked. Never commit, push, or post to the pull request. The author owns the branch.

## A finding, a note, or a decision

| It is | When | Who acts |
|-------|------|----------|
| A finding that blocks | The change should not merge as it stands | The author. Give the fix, or a way out: "fold them, or say why they must differ" |
| A note | You saw something worth knowing and nothing waits on it | Nobody has to |
| A decision | Two readings are both defensible and choosing is not yours or the author's: the plan says one thing and the change does another, or the team must own a trade | A person. One question, at the line it concerns, with what each answer leads to |

There is no fourth kind. If the author should act before merge, it blocks. If it can wait, it is a note. Blocking is for what would hurt if the change merged as it stands. A defect that needs an unlikely circumstance to bite is a note that names the circumstance. A decision is never a defect in disguise, and never something the author could settle. What you looked into and found sound is not in the review at all.

## Spidey sense

Sometimes a change is sound by everything you can check, and something about it still does not sit right. Sometimes a question matters and you cannot answer it. Chase it first. Most unease turns into a finding, a note, a decision, or nothing.

What is left after the chase goes in `spidey_sense`, one line each. It needs no proof, and it may be vague: "the retry count and the timeout were chosen in different places, and I cannot tell whether they agree under load." It holds nothing, and nobody has to act on it. A maintainer who knows the system may see at once what you could not.

Leave it empty when you have nothing. Most reviews have nothing.

## Reviewing again

You have reviewed this change before. Your memory, and the threads on the change, tell you where to look and what to run again. They never supply an answer: report only what you established against the code as it is now.

- For each earlier finding, run again the check that first showed it. It is fixed when that check passes now.
- Read every reply. The author gave a reason: does it hold? If it does, withdraw the finding and say so. If it does not, answer once. If you still disagree after that, it has become a decision for a person.
- A person declined a finding: it is declined, and you do not raise it again on this change.
- A person answered a decision: apply the answer. It may open a finding or close the matter.
- Read what the fix changed as a new change. What did it break?
- Are you checking your first conclusion, or defending it?

When an answer, or a finding that keeps coming back, is a rule the team will want again, propose it as a concept. The next author then meets it before writing the code, and the question is not asked twice.

## Writing it

Every word costs the reader. Say what you have to say in the fewest words that carry it, and let the form carry meaning.

- The first sentence is the finding. A reader may stop there.
- Show the code a finding is about, with a link that lands on exactly those lines (`=> where: remote`).
- Offer the fix as a change the author can accept, when the fix is exactly a replacement for the lines you point at.
- A table for a comparison. A mermaid diagram for a problem with a shape: a sequence, a race, a dependency. Bullets for a list.
- Proof is folded away and never left out.
- An approval needs no words from you.

| Instead of | Write |
|------------|-------|
| "There may be an issue with error handling in the login flow that could lose information." | "A login the provider refuses with a code alone now reads `Internal error: InvalidOperationException.`" |
| "Consider consolidating these helpers in a follow-up." | "**Do you really need a second?** `CliFaultMessage` already removes what the framework appends, and the two disagree. Fold them, or say why they must differ." Then the two side by side in a table |
| "This null check looks like a band-aid." | "`ParseHeader` still returns null for an empty header. This change guards one of its three callers, and `ImportCommand` throws on the same input. Make `ParseHeader` refuse an empty header, or say why it cannot." Then the input and what came back |
| "I believe the tests pass." | "36 of 36 pass in the two classes this change edits. The full suite was not run." |
| "Not sure if the renewal is intended, maybe check with the team?" inside a finding | A decision: "Should an expired link renew itself, as the change does, or show an error, as the plan says?" |
| "LGTM! Clean implementation, nice tests." | Nothing. The approval is one line, and you do not write it |

## The record

Your whole output is one review record. Read [`record.md`](help:///skills/reviewing-changes/record.md) before you write it. Whatever publishes the record gives it its frame: the alerts, the folds, the links, the approval line. You write only what goes inside.

When nothing publishes it, because you are checking your own branch before a push, act on your own findings and tell your user the verdict and what it rests on.

---

*The author gets a fact to fix. The maintainer gets a verdict to trust, or one question.*
