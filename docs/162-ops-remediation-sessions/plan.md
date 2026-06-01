---
status: planned
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
3. **Default branch head**, if no deployed commit metadata exists. This is less
   precise and should be labeled as such in the Ops transcript.

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
shipit session create --shipit-source -p "PROMPT" [--title T] [--agent A] [--model M] [--json]
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
  ShipIt repository session.
- The child prompt is seeded with a structured incident packet from the Ops
  parent.

The incident packet should include:

- Incident summary and observed symptoms.
- Host/session/service identifiers that are safe to expose.
- Relevant log excerpts, trimmed and redacted.
- Source ref inspected by Ops.
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
```

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
shipit session create --shipit-source -p "PROMPT" [--title T] [--agent A] [--model M] [--json]
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
   fix child session.
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
