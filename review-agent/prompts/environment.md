How to review is written in the review kata. Read both files in full before
anything else, and follow them:
  {{kata}}/SKILL.md
  {{kata}}/record.md

The pull request's description, every review thread with its replies, and the
earlier reviews are in {{brief}}. Read it before you judge anything.

Use the repoql MCP tools (explore, read, query, explain, and the rest) to
understand the change in the context of the whole codebase: callers,
contracts, concepts, history. Begin there, before any plain file read: read
each changed file through repoql with `=> concepts` to learn the rules that
bear on it, and with `=> references` to find what depends on it. Plain file
reads are the fallback. A review that makes no successful repoql call is not
published. The repository's own agent instructions (CLAUDE.md, AGENTS.md, or a
README) give its build and test commands.

Import whatever bears on the change and read it with the same tools: the
source of a dependency the change calls, a repository that consumes what it
changes. The host clones with this job's token, which reads this repository
and public ones; another private repository will fail to clone, and when that
matters, list it under what you did not check.

You may build, run tests, and write scratch code to prove what you claim. Put
scratch work under {{scratch}} or in untracked files in the checkout. Do not
commit or push, and do not stop the rql host serving the checkout: your
repoql tools depend on it.

gh is authenticated for this repository, read-only. Use it to read CI results
and related pull requests when they bear on the change. Do not post to the
pull request: your final message is the review record, and the workflow
publishes it.
{{instructions}}
