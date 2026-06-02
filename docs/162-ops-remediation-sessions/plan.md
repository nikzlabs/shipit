---
status: in-progress
priority: high
description: Give Ops sessions read-only ShipIt source access for diagnosis, then spawn targeted repo-backed fix sessions that can open normal PRs.
---

# 162 — Ops remediation sessions

## Problem

Ops sessions can diagnose production host issues from inside ShipIt: Docker
state, session containers, service logs, and host journals are visible without
giving the agent a mutating Docker socket. That boundary is correct, but it
still leaves the Ops agent under-informed when the incident is likely caused by
a ShipIt bug.

The common failure mode is:

1. Ops sees a broken container, lifecycle loop, stale runner, preview failure,
   GitHub polling issue, or deployment bug.
2. The useful clues are in production logs and in the ShipIt source code.
3. The Ops session can inspect the logs but cannot inspect the ShipIt source
   tree directly.
4. The Ops agent can describe the symptom, but cannot create a targeted fix
   session with the right files and root-cause hypothesis.

The missing capability is not broad access to customer repositories. It is
read-only access to the **ShipIt source code that is running this host**, plus a
safe way to delegate the fix to a normal repo-backed ShipIt session.

## Current State

The current implementation does not give Ops sessions a documented, narrow
ShipIt source surface in the Ops workspace, but production topology likely
allows source inspection indirectly.

Evidence:

- `src/server/orchestrator/templates-ops.ts` bootstraps only the Ops workspace:
  `README.md`, `shipit.yaml`, `docker-compose.yml`, and investigation prompts.
- `src/server/shared/shipit-config.ts` only allow-lists these host mounts for
  Ops: `/var/run/docker.sock`, `/var/log/journal`, and `/run/log/journal`.
- `src/server/orchestrator/container-lifecycle.ts` applies those host mounts
  read-only only when `config.opsSession` is true. There is no mount for the
  ShipIt source checkout.
- `src/server/shipit-docs/ops-session.md` documents read-only Docker and
  journal access, and explicitly says there are no other host paths.
- `deployment/vps/docker-compose.yml` mounts the host checkout into the
  orchestrator container as `/opt/shipit:/opt/shipit`, and the prod image also
  contains runtime source under `/app/src`.

So when an Ops agent can read ShipIt source today, the likely path is the
read-only Docker API: inspect the `shipit` orchestrator container, then read
files from its mounted `/opt/shipit` checkout or baked `/app/src` tree. That is
useful, but it is an emergent capability of Docker container-read access, not a
first-class Ops contract. It is also broader than the actual product need,
because generic container filesystem reads can expose runtime files that are
not source code.

This feature should keep the useful behavior but make it explicit, narrow, and
testable: Ops should have a supported read-only ShipIt source surface without
depending on ad hoc `docker cp` / container-filesystem reads.

## Goals

- Let an Ops session inspect the ShipIt source code read-only while
  investigating host issues.
- Make the source snapshot match the code deployed on the host as closely as
  possible.
- Let the Ops agent create a targeted child session in the ShipIt repository,
  seeded with the diagnosis, logs, suspected files, and reproduction steps.
- Preserve the current Ops safety contract: no Docker writes, no host
  filesystem writes, and no direct commits from the Ops workspace.
- Work when the operator has write access to the ShipIt repository, and degrade
  clearly when the operator has only read access.
- Keep the diagnosis, spawned fix session, PR, CI, and follow-up inline in
  ShipIt.

## Non-goals

- Do not give Ops writable access to the ShipIt source checkout.
- Do not turn the Ops workspace itself into a branch of `ship-it`.
- Do not grant the Ops container arbitrary GitHub API access.
- Do not add generic customer-repo browsing to Ops as part of this feature.
- Do not add host mutation controls to the Host tab.

## Design

### Two separate capabilities

This feature deliberately separates **read access for diagnosis** from **write
access for remediation**.

1. **Read-only ShipIt source context in Ops**
   The Ops session can search and read the ShipIt source tree that corresponds
   to the running host. This gives the Ops agent enough context to connect logs
   to code paths and identify candidate fixes.

2. **Repo-backed ShipIt fix session**
   When the Ops agent has a fix hypothesis, it spawns a normal ShipIt session
   targeting the ShipIt repository. The child owns edits, tests, commits, push,
   and PR creation. The Ops parent only receives status snapshots and can send
   follow-up prompts through the existing spawned-session controls.

This preserves the security boundary: Ops can inspect production and source
read-only; normal repo sessions perform code mutation through the existing Git
and PR machinery.

### Source Snapshot

The source context should be orchestrator-owned, not a writable bind mount from
the host into the Ops workspace.

Recommended source selection order:

1. **Exact deployed commit**, if the orchestrator can determine it from build
   metadata, image labels, environment, or a persisted deployment record.
2. **Current server checkout**, if production runs from a mounted checkout and
   the orchestrator can safely expose a read-only snapshot of it.

If neither source is available, `shipit source status` should report that the
running source is unavailable. `tree`, `search`, and `cat` should fail rather
than silently serving the repository's default branch. An explicit approximate
mode can be added for emergency investigation, but it must be opt-in on the
command, clearly marked in the output, and carried into any incident packet so a
child fix session does not look exact when it is not.

The snapshot should be exposed through a narrow CLI surface first:

```bash
shipit source status
shipit source search "ContainerSessionRunner"
shipit source cat src/server/orchestrator/session-container.ts
shipit source tree src/server/orchestrator
```

Why CLI-first:

- It can be brokered through the existing `/agent-ops/*` trust boundary.
- It avoids mounting `.git`, credentials, writable worktrees, runtime
  directories, or arbitrary host paths into the Ops container.
- It avoids relying on broad Docker container filesystem reads as the source
  access mechanism.
- It gives us a small testable allow-list: status, tree, search, cat.

If local tools become important later, add a read-only generated snapshot mount
under a reserved path such as `/workspace/.shipit/shipit-source`. That mount
must be detached from the writable repo cache and must not expose Git
credentials or write-capable checkout metadata.

### What Source Access Allows

Allowed:

- Search file contents.
- Read specific files.
- List directories.
- Report the source ref and whether it is exact or approximate.
- Include file references in a remediation prompt.

Rejected:

- Editing files.
- Creating commits.
- Running arbitrary Git commands against the source snapshot.
- Reading credential files, `.env` files, private runtime state, or `.git`
  internals.
- Using source access as a general host filesystem mount.
- Using `docker cp` or equivalent container archive APIs as the blessed source
  browsing mechanism.

### Spawned Fix Session

The write path should use the existing agent-spawned session system from doc
117, with an Ops-specific target:

```bash
shipit session create --shipit-source --prompt-file FILE [--title T] [--agent A] [--model M] [--json]
```

Equivalent naming could be `--repo shipit`, but the important behavior is that
this is a first-class "fix ShipIt itself" target, not a generic cross-repo
spawn.

Behavior:

- Only Ops sessions can use this target.
- The orchestrator validates that the current user can write to the configured
  ShipIt source repository before creating the child session.
- If the user lacks write access, the command fails with a clear inline error
  and leaves the Ops diagnosis intact.
- The child session is created through the same repo claim path as a normal
  ShipIt repository session, then reset or branched from the exact source ref
  that Ops inspected. A diagnosis against deployed commit `abc123` must produce
  a child branch whose starting point is `abc123`, not the repository's current
  default branch.
- If the inspected source is approximate, the spawn should either fail before
  the child starts editing or create a visibly approximate remediation session
  only when the user/agent explicitly requested approximate-source remediation.
- The child prompt is seeded with a structured incident packet from the Ops
  parent.

The incident packet should include:

- Incident summary and observed symptoms.
- Host/session/service identifiers that are safe to expose.
- Relevant log excerpts, trimmed and redacted.
- Source ref inspected by Ops.
- Whether the source ref was exact or approximate.
- Source files and symbols inspected by Ops.
- Suspected root cause and candidate files.
- Constraints: tests to run, behavior to preserve, and what not to touch.
- Linkage back to the Ops parent session.

The child owns all file edits, tests, commits, pushes, and PR creation. The Ops
parent can `view`, `wait`, and `message` the child using existing spawned
session controls, but it cannot read the child's filesystem directly or push its
branch.

### Read-Only Access Without Write Access

Some operators may be able to run or inspect ShipIt in an ORC-style deployment
without write access to the upstream ShipIt repository.

In that case:

- `shipit source *` should still work if the user is authorized to operate the
  host.
- `shipit session create --shipit-source` should fail before creating a child,
  because the user cannot push a fix branch or open a PR against the source
  repo.
- The Ops agent should produce a structured incident report with source
  references and a recommended patch outline.

Future work can add an explicit fork or downstream repo target, but v1 should
not silently choose a fork. The user should see where code will be changed.

### Inline UX

The Ops chat should render a remediation card when a ShipIt fix session is
spawned. It should be similar to the existing `SpawnedSessionCard`, with
Ops-specific context:

- Source ref inspected by Ops.
- Target repository and branch.
- Diagnosis summary.
- Child status: starting, running, idle, PR opened, CI failing, CI passing.
- Latest child assistant summary.
- PR lifecycle summary when the child opens a PR.

The Host tab can surface the source-ref status and recent source references,
but it should not add buttons that run commands or mutate state. The user can
ask the Ops agent in chat to inspect source or spawn a fix session.

### Trust Boundaries

| Risk | Mitigation |
|---|---|
| Ops mutates production Docker state | Existing read-only Docker proxy remains unchanged. |
| Ops mutates ShipIt source directly | Source context is read-only; no Git writes from Ops. |
| Ops sees host paths outside the contract | Source is brokered or snapshotted; no arbitrary host bind mount. |
| Ops opens PRs without write access | Orchestrator checks write permission before child creation. |
| Source snapshot does not match production | Surface exact vs approximate source status in `shipit source status` and in the remediation packet. |
| Logs include secrets | Redact incident packets before passing them to the child session; keep raw logs in the Ops transcript only when already visible there. |
| Agent creates many fix sessions | Reuse spawned-session quotas, with a lower Ops-specific per-turn default if needed. |

## API and CLI Shape

### Read-only ShipIt source

New shim commands, brokered through `agent-ops-routes.ts`:

```bash
shipit source status [--json]
shipit source tree [path] [--json]
shipit source search "query" [--path PATH] [--json]
shipit source cat path/to/file
shipit source log [path] [--limit N] [--json]
shipit source blame path/to/file [--json]
shipit source show <commit> [path] [--json]
```

`log`/`blame`/`show` exist because the most common Ops question for a regression
is "what recently changed near this code path?" — they connect a production
symptom to the commit that introduced it. All three are inherently read-only and
run `git` plumbing against the resolved snapshot ref like the other reads.
`show` post-filters its diff so a commit that also touched a redacted file
(`.env`, key material) never leaks that file's contents; `log`/`blame` reject
redacted paths up front.

Rejected:

- `shipit source edit`
- `shipit source commit`
- `shipit source push`
- `shipit source checkout`
- `shipit source git`
- Any command that exposes credentials or raw Git config.

### ShipIt fix-session spawn

Extend the existing session shim:

```bash
shipit session create --shipit-source --prompt-file FILE [--title T] [--agent A] [--model M] [--json]
```

Behavior:

- Without `--shipit-source`, existing same-repo spawn behavior stays unchanged.
- With `--shipit-source`, the parent must be an Ops session.
- The configured ShipIt source repo must be readable for source context.
- The configured ShipIt source repo must be writable for remediation spawn.

## Implementation Plan

1. Add an orchestrator service that resolves the running ShipIt source ref and
   exposes a read-only source snapshot.
2. Extend the `shipit` shim with `source` read commands and worker allowlist
   routes.
3. Add orchestrator routes for source status/tree/search/cat scoped to Ops
   sessions.
4. Add source snapshot redaction rules so credentials, `.env` files, and `.git`
   internals are never exposed through the CLI.
5. Extend `spawnChildSession()` or add a wrapper to create an Ops-only ShipIt
   fix child session based on the exact inspected source ref.
6. Add read/write permission checks for the configured ShipIt source repo.
7. Add an incident-packet builder used by Ops prompts and the spawn route.
8. Add an Ops remediation card in parent chat, reusing the spawned-session
   status pipeline where possible.
9. Update agent-facing docs so Ops agents know the sequence: inspect host,
   inspect ShipIt source read-only, spawn fix session, wait/view/message child.

## Key Files

| File | Expected change |
|---|---|
| `src/server/session/agent-shim/shipit.ts` | Add `shipit source *` commands and `shipit session create --shipit-source` parsing. |
| `src/server/session/agent-ops-routes.ts` | Broker read-only source routes and ShipIt fix-session spawn requests. |
| `src/server/orchestrator/services/shipit-source.ts` | New service for source ref resolution, snapshot access, search, and redaction. |
| `src/server/orchestrator/services/child-sessions.ts` | Allow Ops-only ShipIt fix-session creation through the existing spawned-session pipeline. |
| `src/server/orchestrator/github-auth-repos.ts` | Add or reuse read/write permission checks for the configured ShipIt source repo. |
| `src/server/orchestrator/api-routes-session.ts` | Thread the Ops-only ShipIt fix target into spawn route handling. |
| `src/server/orchestrator/api-routes-source.ts` | New read-only source context endpoints, or equivalent route module. |
| `src/server/shared/types/domain-types.ts` | Add any remediation-card or source-context metadata types. |
| `src/client/components/SpawnedSessionCard.tsx` | Either extend for remediation context or compose a new Ops-specific card. |
| `src/server/shipit-docs/ops-session.md` | Update the agent-facing Ops contract with read-only ShipIt source investigation and child-session remediation flow. |
| `src/server/shipit-docs/sessions.md` | Document the Ops-only ShipIt fix-session spawn behavior. |

## Implementation notes (v1)

Source ref resolution (`services/shipit-source.ts`):

- The source checkout is the orchestrator's host bind mount, `/opt/shipit` by
  default, overridable with `SHIPIT_SOURCE_DIR`.
- The ref is the **exact** deployed commit when `SHIPIT_BUILD_ID` (baked at
  image build from `git rev-parse HEAD`, see `build-id.ts`) resolves to a commit
  present in the checkout. Otherwise it falls back to the checkout's HEAD and is
  reported as **approximate** (`refSource: "checkout-head"`, `exact: false`).
- The fix-repo URL is the checkout's `origin` remote, overridable with
  `SHIPIT_SOURCE_REPO_URL`. The host `origin` carries an embedded GitHub PAT
  (`https://x:<pat>@github.com/o/r.git`); `getShipitSourceStatus` strips it via
  `stripUrlCredentials` (git-utils.ts) so the URL that's displayed, used as a
  repo-store key, and persisted into the child's session config is always
  credential-free. Auth is injected at git-operation time by the credential
  helper, never via the URL.
- All reads (`tree`/`search`/`cat`/`log`/`blame`/`show`) run `git` plumbing
  against the resolved ref, never the working tree, so they always match
  `status`. Redaction (`isRedactedSourcePath`) blocks `.env`, key material, ssh
  keys, `.netrc`/`.npmrc`, and `.git/` internals. `log`/`blame` reject a
  redacted path before touching git; `show` post-filters its diff
  (`filterRedactedDiff`) to drop per-file sections for redacted paths so a
  commit that also touched `.env` can't leak it through the diff, leaving a
  visible "N file diff(s) hidden" note. `show`'s commit argument is validated
  (`normalizeCommitish`) so it can't be parsed as a git flag.

Write path:

- `shipit session create --shipit-source` → `/spawn` with `shipitSource: true`.
- The spawn route validates `kind === "ops"`, resolves the fix target
  (`resolveShipitFixTarget`), checks GitHub push access
  (`GitHubAuthManager.checkRepoWriteAccess`), registers + readies the ShipIt
  repo (`ensureShipitSourceRepoReady`), seeds the incident packet
  (`buildShipitFixPrompt`), and spawns a normal child via `spawnChildSession`
  with `repoUrlOverride` + `base = <exact ref>`. The child opens its own PR
  through the existing pipeline.
- Repo identity is canonical (`canonicalRepoKey`): `ensureShipitSourceRepoReady`
  reuses the entry the user already added through the home screen instead of
  registering a credentialed near-duplicate (a credentialed origin URL,
  different host casing, or a `.git` suffix all collapse to the same key), and
  returns the credential-free store key the spawn uses as `repoUrlOverride`.
  Because the override is credential-free, the child clones/pushes with the
  connected GitHub account credential injected by `configureGitCredentials` —
  the *same* token `checkRepoWriteAccess` validates in the pre-flight — rather
  than a PAT baked into the source checkout's origin.

PR base vs. deployed ref (mergeability):

- The child branches from the **exact deployed commit** so it can reproduce the
  bug against the code actually running in production — which is usually behind
  the repo's default branch. The PR it opens targets the default branch.
- The displayed PR diff is *not* polluted by intervening default-branch commits:
  GitHub's three-dot diff is computed against the merge-base, which is the
  deployed commit, so it shows only the fix. The real risk is mergeability — if
  the default branch moved the same lines, or the bug was already fixed
  upstream. `buildShipitFixPrompt` therefore instructs the child to `git fetch`
  and rebase onto the latest default branch (re-applying its fix and resolving
  drift) before opening the PR, and to *not* open a PR if the root cause was
  already fixed upstream. The deployed commit is the reproduction starting point,
  not the merge target.

Quota:

- Fix-session spawns get a lower per-turn cap than generic fan-out children:
  `DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN` (env
  `MAX_SHIPIT_FIX_SESSIONS_PER_TURN`, default 2), passed as
  `maxSpawnedSessionsPerTurn` only when `shipitSource` is set. The per-parent cap
  (16) still applies. Each fix child claims the ShipIt repo and opens a PR, so it
  is heavier and higher-stakes than a research/codegen fan-out child.

TOCTOU between inspection and spawn:

- `resolveShipitFixTarget` re-resolves `status` at spawn time, so the ref the
  child branches from is whatever is deployed *now*, not whatever the agent
  inspected earlier in the turn. If a deploy lands mid-turn the two can differ.
  This is bounded, not eliminated: the incident packet records the ref the child
  *actually* branched from (and its exact/approximate flag), so a reviewer can
  always see the true starting point. An exact→approximate flip between inspect
  and spawn will additionally fail the spawn unless `--approximate` is passed.

Authorization:

- Every `source/*` route and the `--shipit-source` spawn are gated on the
  server-authoritative `session.kind === "ops"` — the same gate that controls
  the privileged Docker/journal mounts (docs/128). *Who can create an Ops
  session* is the actual authz boundary: per docs/128 ("Auth gate"), v1 is
  single-tenant — host operator == ShipIt user, and the gated Settings template
  route is the only way to mint a `kind: "ops"` session. A multi-tenant "ops
  role" is explicitly deferred there. docs/162 adds no new authz surface; it
  rides on that gate.

### Key files added/changed

| File | Change |
|---|---|
| `src/server/orchestrator/services/shipit-source.ts` | New: ref resolution, status/tree/search/cat/log/blame/show, redaction (incl. `filterRedactedDiff`/`normalizeCommitish`), fix-target + incident-packet helpers. |
| `src/server/orchestrator/api-routes-source.ts` | New: Ops-gated `/api/sessions/:id/source/*` routes (status/tree/search/cat/log/blame/show). |
| `src/server/session/agent-ops-routes.ts` | Broker `/agent-ops/source/*` (incl. log/blame/show). |
| `src/server/session/agent-shim/shipit.ts` | `shipit source *` commands (incl. log/blame/show); `--shipit-source` / `--approximate` on `session create`. |
| `src/server/orchestrator/github-auth-repos.ts` + `github-auth.ts` | `checkRepoWriteAccess`. |
| `src/server/orchestrator/services/child-sessions.ts` | `repoUrlOverride` spawn option; `DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN`. |
| `src/server/orchestrator/api-routes-session.ts` | `/spawn` handles the Ops `--shipit-source` target; applies the lower fix-session per-turn cap. |
| `src/server/orchestrator/services/shipit-source.test.ts` | Unit tests incl. log/blame/show + `filterRedactedDiff`. |
| `src/server/orchestrator/integration_tests/ops-source-routes.test.ts` | Route tests incl. log/blame/show + show-diff redaction. |
| `src/server/orchestrator/integration_tests/ops-fix-spawn.test.ts` | New: write-path tests (writable child branched from exact ref; no-write 403; non-ops 403). |
| `src/server/shipit-docs/ops-session.md`, `sessions.md` | Agent-facing contract. |

Remaining work is tracked in `checklist.md` (notably the Ops remediation chat
card, which currently reuses the generic `session_spawned` card).

## Open Questions

1. What is the most reliable source of the deployed ShipIt commit in production?
   Recommendation: record commit metadata during deploy and expose it through
   `shipit source status`.
2. Should the source context be CLI-only or also mounted read-only?
   Recommendation: CLI-only first; add read-only generated snapshots later if
   the agent needs local tooling.
3. Should users without upstream write access be able to target a fork?
   Recommendation: not in v1. Produce a structured incident report until the
   fork/downstream repo target is explicit.
4. How much raw log context should be copied into the child prompt?
   Recommendation: aggressively trim and redact; link the child back to the Ops
   transcript for full context visible inside ShipIt.
