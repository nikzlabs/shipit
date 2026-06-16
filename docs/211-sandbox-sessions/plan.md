---
issue: https://linear.app/shipit-ai/issue/SHI-161
title: Sandbox sessions (repo-less, capability-scoped)
description: Repo-less sessions that start from an empty workspace; the agent clones what it needs, with Git and session-scoped Docker granted as explicit capability toggles at creation.
---

# Sandbox sessions

## Problem

A ShipIt session is anchored to exactly one repository. `remoteUrl` is set at
creation and never changes; the warm pool, sidebar grouping, PR lifecycle,
auto-push, siblings, and git credentials are all keyed off it. There is no
creation path that produces a session without a repo, and the sidebar nests
sessions *under* repos.

That makes cross-repo and multi-PR agent work awkward or impossible: inspect
repo A while patching repo B, coordinate related PRs, create follow-up PRs
across repos, or do repo-less scratch/compute work where no single repo should
own the session (SHI-161).

## Design decision: ShipIt stays out of the repos

We deliberately reject the heavyweight model (ShipIt brokering repo
*attachments*, mount paths, per-repo trust cards, and multi-PR UI). Instead:

> A **Sandbox session** is a bare container with an empty `/workspace` and an
> explicit set of granted capabilities. The agent clones whatever repos it
> wants and manages its own branches/PRs with `git`/`gh`. ShipIt does **not**
> track, mount, or render those repos.

This is the same shape as the existing **ops** session (`kind = "ops"`): a
server-authoritative session kind with preview/PR machinery turned off. Sandbox
is the second member of that family — minus ops's host-level Docker/journal
privileges.

### Consciously-dropped acceptance criterion

SHI-161 lists "The UI shows all attached repos/PRs and their status." By this
design ShipIt intentionally does **not** see what the agent cloned, so that
criterion is dropped.

This is a **deliberate, scoped product degradation**, not just a simplification —
and it sits in tension with CLAUDE.md §1–§4 ("ShipIt is the surface; inline beats
link-out; PRs/diffs/CI surface inline"). The exception is acceptable **only**
because a Sandbox is explicitly framed as a *lower-level, reduced-visibility
workspace* (closer to a terminal than to a repo-bound project): the user opts
into it from the "advanced session" menu knowing ShipIt won't render the agent's
repos/PRs. It must therefore **not** be marketed as a full inline multi-PR
ShipIt workflow — that richer experience (per-repo PR cards, inline status) stays
a future, separate effort. The narrower SHI-120 "secondary private repo mounting"
is subsumed: in a Sandbox the agent just clones the private repo itself, given
GitHub access.

## Model

### Session kind + capabilities

- Reuse the existing `SessionInfo.kind` field. New value: `kind = "sandbox"`
  (alongside `"ops"`; normal repo-backed sessions leave `kind` undefined).
- Add a `capabilities` set on the session, chosen at creation:
  - `git` (UI label **"GitHub access"**) — the agent gets the GitHub credential
    broker (clone/push **private** repos, brokered PR ops). Off ⇒ no GitHub
    credentials: plain public `git clone` over HTTPS may still work, and the
    container still has its agent API egress — so "off" means **no GitHub token
    / no push to the user's repos**, *not* a fully network-sealed box. (If a
    truly sealed posture is wanted, that's an egress concern — see Security.)
  - `docker` — **session-scoped** Docker (see below). Off ⇒ no Docker.
- `remoteUrl` stays null.

`kind` and `capabilities` are set **server-authoritatively at creation**, never
inferred from workspace files, so an agent cannot self-promote (same rule as
ops `setKind`).

### The sandbox invariant (not merely "no remoteUrl")

Codex review flagged that "repo-less" already half-exists (standalone sessions
are repo-less but git-initialized) and that several paths are **not** actually
guarded by `if (remoteUrl)`. So sandbox is defined by an explicit invariant, not
the absence of a remote:

1. **No root git repo** at `/workspace` (the agent clones into subdirs).
2. **No session-level post-turn git management** — auto-commit/auto-push/PR card
   are skipped by `kind === "sandbox"`, *not* inferred from `remoteUrl`
   (`post-turn.ts` calls `git.autoCommit()` on the session dir **unconditionally**
   today — it must be explicitly gated, or it errors on the non-repo root).
3. **Capability-gated brokers** — git-credential and PR brokers check the
   session's durable `capabilities`, not just container env (see Security).
4. **No preview / PR surfaces**.
5. **Its own sidebar group**, keyed on `kind === "sandbox"`, separate from the
   defensive `remoteUrl ?? ""` standalone bucket (`sessions.ts`) so unrelated
   no-remote sessions don't get lumped in.

### What turns off (mirrors ops)

| Surface | Sandbox behavior |
|---|---|
| Preview / compose services | Off (no `x-shipit-preview`; ops keeps a docker proxy sibling, Sandbox keeps nothing unless `docker` granted) |
| PR lifecycle card / auto-push | Off — gated on `kind === "sandbox"` |
| Session-level auto-commit | Off — **explicitly** skipped for sandbox (not auto-off: `post-turn.ts` commits the session dir unconditionally today; the non-repo root would error otherwise) |
| Branch-op blocking shim | Off — the agent owns its own branches/PRs (see PR brokering) |
| `RELEASES` / `NEW_PROJECT` prompt fragments | Dropped, like ops |
| UI | PR lifecycle card replaced by the orientation banner (same chat-panel slot); side-panel Preview & PR tabs removed (Files + Terminal remain) |
| Sidebar | Own group + badge, like the Host / Ops group |
| Warm pool | Cheaper to warm — no clone needed |

### What stays on

Files tree, terminal, chat history (persists in the DB regardless of repo), and
— when `git` is granted — the GitHub credential broker so the agent can clone,
push, and open PRs (via the repo-aware shim below). A Sandbox-specific
**system-prompt variant** tells the agent: no bound repo; clone what you need
into `/workspace/<name>`; ShipIt won't render previews or PR cards for these; open
PRs per-repo with `gh` from inside each clone; the workspace persists between
turns on disk but treat pushed state as the source of truth.

### PR brokering in a Sandbox — the shim must become repo-aware (CRITICAL)

The current `gh` shim (`agent-shim/gh.ts`) **rejects `--repo`** and brokers every
PR op through `/agent-ops/pr/*`, which the orchestrator resolves against the
*session's* fixed `remoteUrl` and a workspace-root `GitManager`
(`api-routes-github.ts`). In a Sandbox there is no `remoteUrl` and repos live in
`/workspace/<name>` subdirs — so **the agent cannot open PRs at all** with the
shim as-is. Using the real `gh` is not an option (per-agent credential isolation;
only the shim is installed, and it deliberately avoids exposing the raw token).

So a Sandbox needs a **repo-aware PR broker**:

- The shim infers the **target repo from the working directory's git origin**
  (the cwd's clone) rather than a fixed session repo, and **allows `--repo`** in
  sandbox sessions to target a specific clone explicitly.
- The `/agent-ops/pr/*` routes build their `GitManager`/remote from that resolved
  clone, not `session.remoteUrl`.
- The token still never reaches the agent — brokering and the
  per-repo-scoped-token path (SHI-79) are preserved; we widen *which* repo the
  broker may act on (any repo the user can access) but keep the no-raw-token
  property.

This is net-new work the original plan under-scoped; it is the piece that makes
the multi-PR premise real, so it moves into Phase 2 as a first-class item.

### Docker scope (session-scoped, not host)

The Docker toggle flips the existing `dockerAccess` capability (docs/128), which
is already a complete, hardened, **session-scoped** engine — no new isolation
work:

- `DOCKER_HOST` points at the per-session Docker proxy (`docker-proxy.ts`), not
  the host socket.
- Every container/network/volume the agent creates is labeled with the session
  ID; `docker ps`, networks, and volumes are filtered to **only the session's
  own** resources. No cross-session visibility.
- `--privileged`, host bind-mounts, and host-path-escape volume tricks are
  rejected by the sanitizer; resource limits are injected on child containers;
  source-IP→session identity (NET_RAW dropped to prevent spoofing).
- The agent gets a dedicated per-session bridge network and the docker-enabled
  worker image (docker CLI baked in).

The **host**-level flavor (read-only host socket proxy + journal mounts) stays
exclusive to the ops template — a user-facing toggle never grants host
introspection. Because a sandbox now adds a **user-facing** Docker toggle (ops's
was template-only), these must be locked down by explicit acceptance tests, not
just relied on from the existing path:

- sandbox `DOCKER_HOST` = the session proxy, **never** `OPS_DOCKER_HOST`;
- `opsSession` is false, no journal/host mounts, no host socket reachable;
- child containers/networks/volumes are reaped on archive/teardown (the
  `removeVolumes` path), so a sandbox can't leak Docker resources.

### Workspace persistence

The per-session workspace dir is bind-mounted from the host and **persists
across idle container destruction** (the "re-clone from git" only happens at
initial claim; idle eviction preserves the dir for resume). So a Sandbox keeps
whatever the agent cloned/created between turns. The only reaper is the opt-in
archived-workspace sweep, which touches *archived* sessions only. This satisfies
SHI-161's "artifacts and logs remain discoverable even when no repo is attached."

### The session banner is derived chrome, not a chat card

The "Sandbox session — no repository bound" orientation banner is **derived UI
state**, rendered from the session's durable `kind`/`capabilities` metadata —
like the PR lifecycle card, the ops Host tab, and the tab gating. It is **not** a
chat-history message and must not be emitted into the transcript stream.

- Survives page reload / session switch (rehydrated from HTTP bootstrap),
  server/container restart (read from the `sessions` table), and WS reconnect
  (it isn't WS-dependent) — because the *metadata* is durable, not because a card
  was persisted.
- This deliberately avoids the persist-on-emit chat-card path (CLAUDE.md
  "transcript content must be persisted"): we don't want a banner copy in the
  scrollback that could duplicate on replay. The only durable write is the
  set-once `kind`/`capabilities` columns at creation.

## Creation UX

A **`+` affordance in the row above the session list** opens a small menu to
create a "complicated" session, with two items today: **Sandbox** and **Ops**.
Choosing Sandbox opens a capability dialog with **Git access** and **Docker
access** toggles plus inline docs on what each grants and the session's
limitations (no preview, no PR card). This centralizes the privileged-session
story in one discoverable place and leaves the normal repo-claim flow untouched.

- "Start a session from chat without choosing a repo" (SHI-161 acceptance) ⇒
  Sandbox with both toggles is a one-click empty session.

## Security notes

- **GitHub access is a real trust expansion.** With `git` granted, the broker can
  act on **any repo the user can access**, not a single bound repo. There is no
  cross-repo credential *inheritance* (the agent never holds a raw token; ops are
  brokered, repo-scoped per SHI-79) — but the *blast radius* widens from one repo
  to the user's whole reachable set. Surfaced explicitly in the creation dialog.
- **"GitHub access off" ≠ network-sealed.** It removes the GitHub credential
  broker (no token, no push to the user's repos), but the container still has its
  normal agent API egress and worker/orchestrator callbacks. A truly sealed
  "run untrusted code" posture is a separate **egress** decision
  (`container-lifecycle.ts` egress enforcement) — call it out rather than imply
  the off state is a sandbox jail.
- **Capability gating must live at the orchestrator broker, not only container
  env.** `GIT_CONFIG_GLOBAL` and the `/agent-ops/git/credential` endpoint are
  always wired; the credential endpoint (and the PR broker) must check the
  session's **durable `capabilities`** before returning a token / acting, so a
  missed env/helper path can't silently self-grant `git`. Defense in depth.
- Docker is session-scoped and host-isolated (above); host access is ops-only,
  enforced by the acceptance tests listed under Docker scope.
- `kind`/`capabilities` are server-set at creation and immutable; agents cannot
  self-elevate.

## Design review (Codex, before implementation)

A cross-agent review (Codex) validated the second-`kind` + `capabilities`
direction and surfaced the corrections now folded in above: the **`gh` shim is
not repo-aware** (the critical gap — see PR brokering), **auto-commit is not
auto-disabled by `remoteUrl`** (must gate on `kind`), **capability gating belongs
at the broker**, **"git off" is not a sealed box**, the sandbox **invariant** must
be explicit (not "no remoteUrl"), the **sidebar group** must be `kind`-keyed, the
dropped inline-PR criterion is a **product degradation** to own explicitly, and
the user-facing **Docker toggle** needs lock-down tests. Nice-to-haves adopted:
rename to "GitHub access", and the real UI **removes** Preview/PR tabs (the
mockup's struck-through tabs are illustration only).

## Key files (to touch)

- `src/server/shared/types/domain-types.ts` — `kind: "sandbox"`, `capabilities`.
- `src/server/shared/database.ts` — `capabilities` column + migration (like the
  `kind` migration #22).
- `src/server/orchestrator/sessions.ts` — `fromRow`/`toRow`, `setCapabilities`.
- `src/server/orchestrator/services/templates.ts` + `templates-ops.ts` — sandbox
  creation path modeled on `applyTemplate` / `OPS_TEMPLATE_ID`.
- `src/server/orchestrator/container-lifecycle.ts` — thread `capabilities` into
  `buildContainerConfig` (`dockerAccess` from the toggle; git creds gate).
- `src/server/orchestrator/ws-handlers/post-turn.ts` — skip session-level
  `autoCommit`/push for `kind === "sandbox"`.
- `src/server/session/agent-shim/gh.ts` + `agent-ops-routes.ts` +
  `api-routes-github.ts` — **repo-aware PR brokering**: resolve the target repo
  from the cwd's clone (allow `--repo`) instead of `session.remoteUrl`.
- `agent-ops` git-credential endpoint — gate token issuance on durable
  `capabilities.git`.
- `src/server/orchestrator/agent-instructions.ts` + `prompts/` — sandbox
  system-prompt variant.
- `src/client/components/SessionSidebar.tsx` — `+` menu, sandbox group + badge.
- `src/client/App.tsx` — tab gating for `kind === "sandbox"`.
- New capability dialog component + creation route/WS message.
- `src/server/shipit-docs/` — document the Sandbox session for the in-container
  agent.

## Visual reference

See `mockup.html` beside this file for the `+` menu, the capability dialog, and
the Sandbox session view (no Preview/PR tabs).

## Phasing

1. **Foundation** — `kind: "sandbox"` + `capabilities` field/column; creation
   route; empty workspace; ops-style turn-offs; sidebar group + tab gating.
2. **Capabilities wiring** — Git-credential gate + Docker toggle through to
   `buildContainerConfig`; system-prompt variant; in-container docs.
3. **Polish** — `+` menu + dialog UX, warm-pool entry for repo-less, tests.
