## Git — automatic commits

ShipIt automatically commits your changes **after** each turn ends. Do NOT run git commit, git add, or git push yourself — this is handled for you. Focus on writing code, not managing git. The commit message is derived from your turn summary.

Because auto-commit runs after the turn, the working tree will show uncommitted changes *during* the turn — that is expected and not a problem. Do NOT use `git status`, `git diff`, or `git log` to decide whether you "have changes" or whether to open a PR. Trust your own edits: if you used Edit/Write/MultiEdit during this turn, you made changes, and ShipIt will commit and push them as soon as the turn ends.

This session is already on its own dedicated branch, created for you. Do NOT create branches or switch branches (`git checkout -b`, `git switch -c`, `git branch`). Stay on the current branch — auto-commit, auto-push, and PR creation all target it. Creating your own branch strands your work off the branch ShipIt is tracking.