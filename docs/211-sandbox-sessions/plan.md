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

### Mental model

A Sandbox is a **regular session with the repo-bound project automation stripped
out** — *not* a session the orchestrator ignores. The orchestrator **stops**:
auto-cloning a repo (empty `/workspace`), running `agent.install` (no root
`shipit.yaml`; the agent's clones live in subdirs it doesn't scan), preview/
compose, auto-commit, auto-push, and the PR card/polling. It **still** provides
the full runtime substrate: container lifecycle, agent process + system prompt,
chat-history persistence, terminal, file tree, and — **gated by the granted
capabilities** — the credential, egress, and Docker brokers. So the shift is
"the orchestrator no longer assumes one project and automates around it,"
brokering capabilities on request instead of automatically.

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
  - `network` (UI label **"Network access"**, default **on**) — controls *how
    contained* egress is. It only ever **tightens**, never loosens (a Sandbox is
    never wider than a normal session):
    - **On** (default) = the standard Tier A allowlist every session already runs
      under (docs/172 / SHI-90): default-deny except `EGRESS_DEFAULT_ALLOWLIST`
      (LLM API, GitHub, package registries) + user-added hosts, with the Tier C
      "allow this host?" card for anything new. **Not** a wide-open mode — there
      is no fully-open option; the allowlist *is* the default.
    - **Off** = **no internet** — locked to the agent's **lifeline only**: the
      LLM API and the ShipIt orchestrator/worker. These are irreducible (cutting
      them kills the agent), so "off" is "lifeline-only," not a literal air-gap.
      No registries, no arbitrary web. **Composition**: granting **GitHub access**
      adds `github.com` to the lifeline set even when Network is off, so push
      still works — GitHub access controls the *token*, Network controls
      *everything else*.
    Reuses `egressEnforce` + `EgressAllowlistStore` (per-session scope already
    exists): "off" simply empties the session allowlist down to the
    identity/lifeline rules (`composeEgressIdentityRules`). **Infra-gated**:
    hidden/disabled where egress enforcement isn't deployed, never a silent no-op.
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
access**, and **Network access** toggles plus inline docs on what each grants and the session's
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
  normal agent API egress and worker/orchestrator callbacks. The lever for a
  locked-down posture is the separate **Network access** capability (above):
  turning it off drops egress to lifeline-only. Even then it is not an air-gap
  (LLM API + orchestrator always allowed), so the Sandbox is positioned for
  multi-repo coordination + defense-in-depth, **not** as a jail for hostile code.
  (Decision: default egress = the standard allowlist, same as any session — there
  is no wide-open mode; Network-off only *tightens* to lifeline-only.)
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

### Foundation landed (Phase 1 + the Phase 3 creation UX)

What shipped, and where it diverged from the sketch above:

- **Data model.** `SessionCapabilities {git,docker,network}` plus
  `DEFAULT_SANDBOX_CAPABILITIES` (network on, git/docker off) and a
  `normalizeCapabilities()` coercer live in `domain-types/session.ts`. The coercer
  is applied at both the creation route (untrusted client payload) and `fromRow`
  (persisted JSON), so a sandbox session always reports a fully-populated set. A
  `capabilities` TEXT column was added by a new migration; `sessions.ts` parses it
  in `fromRow`, widens `setKind` to `"ops" | "sandbox"`, and adds `setCapabilities`.
- **Creation.** `createSandboxSession` (`services/templates.ts`) is modeled on the
  ops `applyTemplate`/`setKind` path but deliberately does **no** `git init` (the
  invariant #1: no root repo) and writes no template files. It is exposed as
  `POST /api/sessions/sandbox` (chosen over a WS message — creation is a one-shot
  request/response with no streaming, like the ops template route) and a
  `createSandboxSession(capabilities)` client store action.
- **Invariant.** The post-turn gate lives in `postTurnCommit`
  (`ws-handlers/post-turn.ts`): a `kind === "sandbox"` session returns `null`
  before constructing a `GitManager`, which suppresses auto-commit, auto-push, and
  (being downstream of a commit hash) the PR card — all keyed on `kind`, not
  `remoteUrl`. `PostTurnCtx` gained `sessionManager` for the lookup.
- **Branch-op shim.** Turned off via a `SHIPIT_SANDBOX=1` CLI env the orchestrator
  sets for sandbox sessions (a `sandbox` flag threaded
  buildAgentRunParams → Claude run-params-prep → adapter → `ClaudeProcess` spawn
  env, mirroring `SHIPIT_AUTO_CREATE_PR`); `block-branch-ops.mjs` self-gates off on
  it. Sandbox also forces `autoCreatePr = false`.
- **UI.** Teal `--color-sandbox` token — bright teal-400 in `:root` (the dark-theme
  value); the six light themes override the trio to a darker teal-700 for text
  contrast on light tints, mirroring `--color-warning`'s per-theme darkening;
  `SandboxSessionGroup` + a teal `sandbox` badge keyed on `kind`; a `+`
  advanced-session menu (`renderAdvancedSessionMenu`) above the session list
  opening `SandboxDialog` (the capability picker) or creating an ops session;
  Preview/PR tabs **removed** for sandbox in `App.tsx`; and `SandboxBanner` —
  derived chrome computed from `kind`/`capabilities`, **not** a chat card — in the
  chat panel's PR-card slot.
  `SandboxDialog`'s open-state lives in `ui-store` (`sandboxDialogOpen` /
  `setSandboxDialogOpen`, mirroring the repo-dialog flags) so the sidebar menu
  opens the one dialog. (The empty `HomeScreen` formerly carried a second
  "Start a sandbox session" on-ramp; it was removed so the front page leads only
  with the GitHub repo flow. The repo *dialogs* themselves (`AddRepoDialog`)
  independently show an inline `GitHubTokenForm` connect prompt when
  unauthenticated rather than a generic failure toast.)

  **Mobile parity.** The advanced-session menu used to be unreachable on mobile:
  it lived only in the desktop sidebar top bar (`!mobile`), and the mobile bottom
  tab bar exposed just the repo-backed quick/voice/new flows — so there was no way
  to create a Sandbox (or Ops) session from a phone. The sidebar top bar now also
  renders inside the mobile **Sessions drawer** (`SessionSidebar`, `mobile`): on
  mobile it shows the `+` advanced menu and the repo switcher (moved here from the
  app header to declutter it), right-aligned, while quick/voice/new stay in the
  bottom tab bar to avoid duplication. There's no collapse/close button on mobile
  — Sessions is one mode of the bottom tab bar's segmented control, so you switch
  away from it rather than closing it. To keep the drawer reachable
  everywhere, `MobileTabBar` is now always rendered on mobile (previously hidden on
  the home screen); on the home screen its Chat/Workspace content tabs are
  `contentTabsDisabled` (no session to view) while Sessions + creation actions stay
  live. Opening `SandboxDialog` from the drawer closes the drawer first (the dialog
  is rendered at App level, so it survives the sidebar unmount).

Phase 2 (building on the stable
`kind`/`capabilities`/`POST /api/sessions/sandbox` contract) shipped as two
parallel efforts, both now landed: capability *wiring* (docker, network,
system-prompt, in-container docs — §Phase 2a) and the orchestrator-side
git-credential gate + repo-aware PR brokering (§Phase 2b).

### Phase 2a landed (capability wiring: docker, network, prompt, docs)

Building on that contract (in parallel with the git-credential +
repo-aware-PR-broker effort in §Phase 2b, which owns `agent-shim/gh.ts`,
`agent-ops-routes.ts`, `api-routes-github.ts`, `pr-target.ts`):

- **Docker → session-scoped proxy.** `buildConfigForWorkspace` gained a
  `dockerAccess?` override (`opts.dockerAccess ?? limits.dockerAccess`); a
  sandbox's empty `/workspace` has no `shipit.yaml`, so the
  server-authoritative `capabilities.docker` grant is threaded in from
  `createContainerForRunner` (`app-lifecycle.ts`) via the session's
  `capabilities`. With it on, `buildEnv`'s existing non-ops `dockerAccess` branch
  routes `DOCKER_HOST` at the per-session proxy and creates the session bridge
  network + compose project — **never** `OPS_DOCKER_HOST`. A sandbox is never
  ops, so the ops-precedence guard (`buildContainerConfig` forces
  `dockerAccess: false` for ops) is untouched and a sandbox gets no journal/host
  mounts (`opsSession` falsy, `hostMounts` undefined).
- **Network → tighten-only egress.** `resolveEgressConfig` (`index.ts`) now calls
  `sandboxLifelineEgressConfig` first: for a `kind === "sandbox"` session with
  `capabilities.network === false` it returns a lifeline-only config — `contained:
  true`, `extraHosts: []`, and `base` narrowed to `EGRESS_LIFELINE_ALLOWLIST` (the
  LLM-API slice) plus `EGRESS_GITHUB_LIFELINE_HOSTS` when `git` is granted. The
  orchestrator/worker lifeline rides `orchestratorInternalNames` (added by the
  resolver/proxy), so it's always reachable. Returns `null` (→ the unchanged
  store-driven path) for every other session, so `network` ON is byte-for-byte the
  normal allowlist. Inert where egress enforcement isn't deployed (the firewall
  install is gated on `egressEnforce && contained`). The live `reloadEgress` path
  reuses the same resolver, so an allowlist edit can't re-widen a sealed sandbox.
- **System-prompt variant.** `agent-instructions.ts` gained a third, mutually
  exclusive session `mode` (`std`/`ops`/`sandbox`) alongside `agentId`; all
  `agentId × mode` variants are still precomputed once at module load (cache
  contract preserved). The sandbox mode splices `prompts/sandbox-session.md`,
  swaps the auto-commit Git guidance for `prompts/git-workflow-sandbox.md` (the
  Git section was tokenized to `{{GIT_WORKFLOW}}`; `git-workflow.md` is the
  unchanged standard), swaps in `prompts/pull-requests-sandbox.md` (per-repo `gh`
  from inside each clone), and drops Live preview + Releases + the new-project
  bullet. `session-agent-run-params.ts` threads the already-computed `isSandbox`.
- **In-container docs.** `src/server/shipit-docs/sandbox-session.md` documents the
  empty workspace, the three capabilities, per-repo cloning/PRs, and persistence;
  linked from `README.md` and `sessions.md`.

### Phase 2b landed (credential gate + repo-aware PR brokering)

The credential gate and the repo-aware PR broker shipped alongside §Phase 2a:

- **Target resolution** lives in `orchestrator/pr-target.ts`. `resolvePrTarget`
  returns `{ gitDir, remoteUrl }` from the request's optional `cwd`/`--repo`
  overrides:
  - `--repo OWNER/NAME` → that GitHub repo (synthesized github.com URL), operating
    on the cwd's clone;
  - else a repo-bound session (`session.remoteUrl` set) → **UNCHANGED**: the
    session root + the session remote (the cwd is *ignored* here on purpose — a
    `--local` clone's origin is a bare-cache path that must not be read);
  - else (sandbox / no remote) → the cwd's clone, reading its own git origin
    (`remoteUrl` undefined).
  `resolveCloneDir` maps the container `/workspace/<name>` cwd onto the host
  session dir and clamps any path-traversal back to the session root.
- **Credential gate** is `gitCredentialAllowed` (same file): only a sandbox with
  `git` off is denied. The `/api/sessions/:id/git/credential` route returns 403
  in that case (the in-container helper treats non-2xx as "no credential", so git
  falls back to anonymous rather than hard-failing). Repo-bound / ops sessions
  are unaffected — defense in depth, not reliance on container env alone.
- **Plumbing.** The `gh` shim (`agent-shim/gh.ts`) drops the `--repo` reject,
  accepts `--repo`/`-R`, and forwards the cwd it ran in plus `--repo` on every PR
  op (body for POST/PATCH, query for GET; the no-PR-number fallback's `pr/status`
  lookup carries the same target). The worker broker (`agent-ops-routes.ts`)
  forwards both through to the orchestrator. `api-routes-github.ts` resolves the
  target on the agent-accessible PR routes and the credential route. UI-driven
  routes (`pr/quick`, `pr`, `pr/merge`, …) are untouched — they only run for
  repo-bound sessions. The **no-raw-token** property is preserved: every PR op
  stays server-side; only *which* repo the broker may act on widens.
- **Key files:** `orchestrator/pr-target.ts` (+ `.test.ts`),
  `orchestrator/api-routes-github.ts`, `session/agent-ops-routes.ts`,
  `session/agent-shim/gh.ts`, `shipit-docs/github.md`.
