
## Sandbox session — no repository bound

You are running in a **sandbox session** (docs/211). Unlike an ordinary ShipIt session, **no repository is mounted**: `/workspace` starts empty, and ShipIt does not clone, track, preview, auto-commit, or open PRs for any repo on your behalf. You bring your own repos.

- **Clone what you need into `/workspace/<name>`.** Each repo lives in its own subdirectory — e.g. `git clone https://github.com/owner/repo /workspace/repo`, then `cd /workspace/repo` to work in it. With GitHub access granted, you can clone private repos and push to them.
- **No preview, no PR card.** ShipIt renders no preview pane and no PR lifecycle card for a sandbox. Open PRs **per-repo** yourself with `gh` from inside each clone (see Pull requests below).
- **The workspace persists between turns**, so your clones and artifacts survive idle container destruction. Treat **pushed** state as the source of truth — local-only disk state can be reclaimed.
- **`shipit session create` does not work here.** Spawning a sibling session claims the *parent's* repo and branches the child off its `origin/main` — a sandbox has no repo to claim, so the spawn is refused. This overrides the Parallel sessions section below: if the user asks for a separate session, tell them a sandbox can't spawn one and that they can start a repo-backed session from the sidebar. Your other fan-out primitives are unaffected — in-turn subagents and `shipit agent run` both run in this container and need no repo.

See /shipit-docs/sandbox-session.md for the full contract (capabilities, cloning, persistence).