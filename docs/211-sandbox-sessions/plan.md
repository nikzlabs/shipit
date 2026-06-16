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
criterion is dropped in favour of simplicity. Recorded here as a deliberate
departure, not an oversight. (The narrower SHI-120 "secondary private repo
mounting" is also subsumed: in a Sandbox the agent just clones the private repo
itself, given Git access.)

## Model

### Session kind + capabilities

- Reuse the existing `SessionInfo.kind` field. New value: `kind = "sandbox"`
  (alongside `"ops"`; normal repo-backed sessions leave `kind` undefined).
- Add a `capabilities` set on the session, chosen at creation:
  - `git` — the agent gets the git credential broker (clone/push private repos,
    `gh`). Off ⇒ a sealed compute box: can pull public code but cannot
    authenticate to or push to anything (a useful posture for running untrusted
    code with no exfil path to the user's repos).
  - `docker` — **session-scoped** Docker (see below). Off ⇒ no Docker.
- `remoteUrl` stays null. The DB column is already nullable; the app-layer code
  that assumes its presence (PR lifecycle, polling, auto-push, siblings) is
  already guarded by `if (remoteUrl)` and simply no-ops — which is what we want.

`kind` and `capabilities` are set **server-authoritatively at creation**, never
inferred from workspace files, so an agent cannot self-promote (same rule as
ops `setKind`).

### What turns off (mirrors ops)

| Surface | Sandbox behavior |
|---|---|
| Preview / compose services | Off (no `x-shipit-preview`; ops keeps a docker proxy sibling, Sandbox keeps nothing unless `docker` granted) |
| PR lifecycle card / auto-push | Off — no single `remoteUrl` to anchor them |
| Auto-commit to remote | Off — `/workspace` root is not a repo |
| Branch-op blocking shim | Off — the agent owns its own branches/PRs via `gh` |
| `RELEASES` / `NEW_PROJECT` prompt fragments | Dropped, like ops |
| UI | PR lifecycle card replaced by the orientation banner (same chat-panel slot); side-panel Preview & PR tabs removed (Files + Terminal remain) |
| Sidebar | Own group + badge, like the Host / Ops group |
| Warm pool | Cheaper to warm — no clone needed |

### What stays on

Files tree, terminal, chat history (persists in the DB regardless of repo), and
— when `git` is granted — the git/`gh` credential broker so the agent can clone
and push. A Sandbox-specific **system-prompt variant** tells the agent: no bound
repo; clone what you need into `/workspace/<name>`; ShipIt won't render previews
or PR cards for these; manage PRs with `gh`; the workspace persists between turns
on disk but treat pushed state as the source of truth.

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
introspection.

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

- Adding/cloning a second repo never inherits another repo's credentials —
  there is no ShipIt-brokered inheritance at all; the agent uses the user's
  git credentials, scoped to what that user can access. **Granting `git` to a
  Sandbox is a deliberate trust expansion**: the session can reach any repo the
  user can. Surfaced in the creation dialog.
- `git` off = no credential broker = sealed compute box.
- Docker is session-scoped and host-isolated (above); host access is ops-only.
- `kind`/`capabilities` are server-set at creation and immutable; agents cannot
  self-elevate.

## Key files (to touch)

- `src/server/shared/types/domain-types.ts` — `kind: "sandbox"`, `capabilities`.
- `src/server/shared/database.ts` — `capabilities` column + migration (like the
  `kind` migration #22).
- `src/server/orchestrator/sessions.ts` — `fromRow`/`toRow`, `setCapabilities`.
- `src/server/orchestrator/services/templates.ts` + `templates-ops.ts` — sandbox
  creation path modeled on `applyTemplate` / `OPS_TEMPLATE_ID`.
- `src/server/orchestrator/container-lifecycle.ts` — thread `capabilities` into
  `buildContainerConfig` (`dockerAccess` from the toggle; git creds gate).
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
