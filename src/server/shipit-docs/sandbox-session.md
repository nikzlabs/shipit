# Sandbox session — repo-less, capability-scoped

If you are reading this inside a **sandbox session**, you are running in a bare
container with an **empty `/workspace`** and an explicit set of granted
capabilities. Unlike an ordinary ShipIt session, no repository is bound: ShipIt
does **not** clone, track, preview, auto-commit, or open PRs for any repo on
your behalf. You bring your own repos and manage them yourself.

A sandbox is created from ShipIt's "advanced session" (`+`) menu. It is marked
server-side with `kind: "sandbox"` plus a fixed set of `capabilities`, chosen at
creation. Like the ops kind, these are set server-authoritatively and cannot be
changed from inside the container — an agent can never self-elevate.

## The workspace

- `/workspace` starts **empty**. There is no root git repo, no `shipit.yaml`,
  and no `agent.install`.
- **Clone what you need into a subdirectory**, one repo per dir:
  ```bash
  git clone https://github.com/owner/repo /workspace/repo
  cd /workspace/repo
  ```
  Work inside the clone (`cd` into it first). Anything at the bare `/workspace`
  root is not a git repo and is never committed by ShipIt.
- **You own git.** ShipIt's automatic commit/push and the branch-creation guard
  are OFF here. Create branches, `git add`/`commit`/`push` inside each clone
  exactly as you would in a normal terminal. Local git always works: a commit
  identity is configured for you, so `git commit` never fails for want of a
  `user.email` even when no GitHub account is connected. Commits are attributed
  to the user's git identity when they have set one, and to a placeholder
  (`ShipIt Agent <agent@shipit.invalid>`) when they have not — reaching the
  network is the part gated by the **GitHub access** capability below, not
  committing.

## Capabilities

A sandbox grants up to three independent capabilities, decided at creation:

- **GitHub access** (`git`). When granted, the GitHub credential broker is wired
  so you can clone/push **private** repos and open PRs across any repo the user
  can access. The token is brokered, never resident in the container. When NOT
  granted, you have no GitHub token: public HTTPS clones may still work, but you
  cannot push to the user's repos. (This is *not* a network seal — see Network.)
- **Docker** (`docker`). When granted, `DOCKER_HOST` points at a **session-scoped**
  Docker proxy: every container/network/volume you create is labelled to this
  session and only this session's resources are visible. There is **no** access
  to the host Docker socket (that is reserved for ops sessions). When NOT
  granted, there is no Docker.
- **Network access** (`network`, default **on**). Controls how contained egress
  is. **On** = the standard allowlist every session runs under (LLM API, GitHub,
  package registries, plus user-added hosts). **Off** = **no internet** — egress
  is locked to the agent's lifeline only (the LLM API and the ShipIt
  orchestrator/worker), with `github.com` re-opened only if GitHub access is also
  granted (so push still works). "Off" only ever tightens; it is never an
  air-gap (the lifeline is irreducible). Egress containment is enforced by default;
  where it's been disabled or the host can't enforce it, the toggle is inert.

## Pull requests

ShipIt renders **no** PR lifecycle card for a sandbox. Open PRs **per-repo**
yourself with `gh`, from **inside** the relevant clone so it resolves the target
repo from that clone's `origin`:

```bash
cd /workspace/repo
git push -u origin <branch>
gh pr create -t "<title>" --body-file - <<'EOF'
## Summary
…
EOF
```

`gh` is the same brokered shim as in a normal session — a curated subset of PR
operations, with the token never exposed. See [github.md](github.md).

## Spawning sessions — not available here

`shipit session create` is **refused in a sandbox**, with or without
`--detached`. Spawning claims the *parent's* repo and branches the child off its
freshly-fetched `origin/main`; a sandbox has no bound repo, so there is nothing
to claim. Cloning a repo into `/workspace/<name>` does not change this — those
clones are yours, not the session's, and ShipIt does not treat any of them as
the session's repo.

If the user asks for a separate session, say a sandbox can't spawn one and point
them at the sidebar to start a repo-backed session. The rest of
[sessions.md](sessions.md) — `list`, `view`, `message`, `wait`, `archive`,
`notify-on-merge` — is likewise inapplicable, since you have no children.

What still works, because neither needs a repo:

- **In-turn subagents**, for parallel research or codegen you synthesize in the
  current reply (the `Task` tool, on backends that have one).
- **`shipit agent run --agent <id> --prompt-file -`**, to consult a different
  agent backend one-shot. See [agent.md](agent.md).

## Persistence

The workspace persists between turns and **survives idle container destruction**
(only the re-clone-from-git that ordinary sessions do at claim time is skipped —
there is no bound repo to re-clone). So your clones and artifacts are still there
next turn. But treat **pushed** state as the source of truth: local-only disk
state can eventually be reclaimed, so push work you want to keep.
