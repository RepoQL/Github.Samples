It is time to review pull request #{{pr}} in {{repo}} again: the author pushed,
or someone replied in a thread. HEAD is now {{head_sha}}.
The last review you completed was of {last_head}.

The whole change is still `git diff origin/{{base_ref}}...HEAD`. When
{last_head} is still in the history, `git diff {last_head}..HEAD` shows what
changed since you last looked. Follow the kata's "Reviewing again": run again
the check behind each earlier finding, read every reply, and report only what
you established against this head.

{{environment}}
