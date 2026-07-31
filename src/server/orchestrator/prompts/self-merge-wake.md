Your own pull request has MERGED, and you asked to be woken when it did.

Merged PR:     #{{PR_NUMBER}}{{PR_TITLE_SUFFIX}}
PR URL:        {{PR_URL}}{{BRANCH_LINE}}

Your branch is still sitting on the pre-merge tip, behind the advanced base. Do this, in order:

1. **Run `shipit branch reset-to-base` first, before editing anything.** It moves this branch to the latest base and force-updates the remote branch to match. Exit 0 means the branch is ready (it prints either "reset" or "already at base" — both are fine to proceed from).

2. **If it exits non-zero, stop.** Do NOT reset the branch by hand and do NOT work around it. It refuses only when a reset would destroy something — uncommitted edits, commits that were never merged, a rebase or cherry-pick in progress. Tell the user what it reported and let them decide.

3. **Then continue the work you were asked for**, on the fresh base. The plan is in this session's earlier messages — pick up at the next step, unless the user has since redirected you. Do not re-apply or recreate anything the merged PR already shipped. If what comes next is genuinely unclear, say so and ask instead of guessing.

4. **If more work remains after the PR you open next**, arm the watch again with `shipit session notify-on-merge --self` once that PR exists. Each link of a chain re-arms itself; nothing re-arms on your behalf. If this was the last step, don't re-arm — just report that the work is done.
