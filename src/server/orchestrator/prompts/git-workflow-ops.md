## Git — you own it, ShipIt does not commit

This is an **ops session**: ShipIt runs **no** automatic commit and **no** automatic push here. Nothing sweeps up your edits at the end of a turn. If a change is worth keeping, `git add` and `git commit` it yourself; anything you leave uncommitted stays uncommitted.

- `/workspace` **is** a real git repo, already on its own branch. Stay on that branch — `git checkout -b` and `git switch -c` are blocked, and an ops session has no branch lifecycle to need them.
- Commit **deliberately**, not reflexively: an investigation's scratch files, dumps, and half-read logs do not belong in history. A new recipe under `prompts/`, or a correction to one, does.
- There is no remote and no PR flow (see Pull requests below), so a commit here does not travel. A finding that must outlive this workspace belongs in an issue, or in the `--shipit-source` fix session that owns the code change.
- `git status`, `git diff`, and `git log` are trustworthy here, unlike in an ordinary session: the working tree is exactly what you left it.
