---
status: planned
priority: high
description: Let Ops sessions inspect relevant source code read-only, then spawn targeted repo-backed remediation sessions that can open normal PRs.
---

# 162 — Ops remediation sessions

## Problem

Ops sessions can diagnose production host issues from inside ShipIt: Docker
state, session containers, service logs, and host journals are visible without
giving the agent a mutating Docker socket. That boundary is correct, but it
creates a follow-on gap. When the Ops agent identifies a product bug, deployment
bug, or repo-specific failure mode, it often cannot inspect enough source code
to produce a precise fix plan, and it cannot create the fix itself.

There are two tempting fixes:

1. Give the Ops session direct write access to the ShipIt source checkout and
   let it create PRs from the Ops workspace.
2. Keep Ops read-only and let it spawn a normal repo-backed session that owns
   the write path.

Pick option 2, with one addition: the Ops session gets **read-only source
access** to the relevant code so diagnosis can be specific before it delegates a
fix. Ops remains the incident investigator; remediation happens in an ordinary
ShipIt session with a normal workspace, branch, auto-commit flow, and PR card.

## Goals

- Let an Ops session inspect relevant source code read-only while investigating
  a host issue.
- Let the Ops agent create a targeted child session in the right repository,
  seeded with the diagnosis, logs, suspected files, and reproduction steps.
- Preserve the current Ops safety contract: no Docker writes, no host filesystem
  writes, no direct commits from the Ops workspace.
- Work for the ShipIt repository when the user has write access, and for ORC or
  customer repositories when the user does not.
- Keep all status inline in ShipIt: the diagnosis, spawned remediation session,
  child PR, CI, and follow-up should all remain visible without making GitHub the
  primary UI.

## Non-goals

- Do not turn the Ops session into a writable checkout of `ship-it`.
- Do not grant the Ops container arbitrary GitHub API access.
- Do not let the Ops agent push branches, open PRs, or mutate repo files
  directly.
- Do not add host mutation controls to the Host tab.
- Do not require the user to leave ShipIt to create the remediation session.

## Design

### Two separate capabilities

This feature deliberately separates **read access for investigation** from
**write access for remediation**.

1. **Read-only source context in Ops**
   The Ops session can request read-only access to one or more repositories that
   are relevant to the incident. Source is exposed as an inspectable snapshot,
   not as a writable Git working tree. The agent can search files, read docs,
   inspect package manifests, and correlate logs to code paths.

2. **Repo-backed remediation child session**
   When the Ops agent has a fix hypothesis, it calls a brokered session-spawn
   command that creates a normal ShipIt session in the chosen repository. The
   child session gets the write-capable workspace and the normal Git/PR
   lifecycle. The parent Ops session only receives a spawned-session card and
   status snapshots.

The existing agent-spawned sessions system (doc 117) is the right foundation
for the second half. The missing pieces are cross-repo spawn support and a
read-only repo-context surface that Ops can use before spawning.

### Read-only source access

Ops sessions need enough source visibility to make targeted remediation
prompts. The safest shape is an orchestrator-owned read-only repo context
service:

- The orchestrator resolves the repositories the current user can read through
  the existing GitHub installation/auth path.
- The orchestrator maintains or reuses bare repo caches for those repositories.
- The Ops session requests a read-only source context by repo and ref, for
  example `shipit repo attach --repo owner/name --ref main`.
- The session worker brokers that request through `/agent-ops/*`; the agent
  cannot call arbitrary repo APIs.
- The orchestrator exposes the snapshot to the Ops container read-only, either
  as a mounted directory under a reserved path such as
  `/workspace/.shipit/read-only-repos/owner__name`, or through a small CLI that
  supports `list`, `search`, and `cat`.

Recommendation: start with a CLI-backed virtual surface rather than mounting a
full checkout. A CLI is narrower and easier to authorize:

```bash
shipit repo list
shipit repo attach --repo owner/name --ref main
shipit repo search --repo owner/name "ContainerSessionRunner"
shipit repo cat --repo owner/name src/server/orchestrator/session-container.ts
```

The CLI should support plain text and `--json`, like the existing `shipit
session` shim. It should never expose credentials, `.git/config`, credential
helpers, or write-capable checkout metadata. If we later need filesystem
mounting for better local tooling, the mount must be read-only and generated
from a detached snapshot directory, not from the shared writable repo cache.

### Selecting the remediation target

The target repository can be explicit or inferred, but it must always be
validated before a child session is created.

Explicit examples:

```bash
shipit session create --repo shipit/shipit -p "Fix the container restart loop..."
shipit session create --repo acme/orc-platform -p "Fix the ORC deploy failure..."
```

Inference can use host/deployment metadata when available:

- A session container label can point back to its repo URL.
- Deployment records can map a failing service to a GitHub repository.
- A stack name can map to a repo imported in ShipIt.
- If multiple candidates exist, the Ops agent should ask the user to choose.

The orchestrator must check two permissions:

- **Read permission** for Ops source context.
- **Write permission** for remediation session creation and PR push.

If the user can read `ship-it` but cannot write it, Ops can still inspect it
read-only, but remediation must target a writable repo such as an ORC repo,
customer app repo, fork, or deployment repo. If no writable target exists, the
Ops session produces a structured incident report with the suspected files and
recommended patch rather than creating a child session.

### Spawned remediation session

Extend `shipit session create` with an Ops-allowed `--repo` flag. This is not a
generic fan-out feature for every session. It is a remediation path with a
specific trust model:

- Only Ops sessions can request cross-repo spawns.
- The worker injects the parent Ops session ID; the agent cannot spoof a parent.
- The orchestrator validates the repo against the current user account.
- The child session is created through the same repo claim path as a normal new
  ShipIt session.
- The child prompt is seeded with a structured incident packet from the Ops
  parent.

The incident packet should include:

- Incident summary and observed symptoms.
- Host/session/service identifiers that are safe to expose.
- Relevant log excerpts, trimmed and redacted.
- Read-only code references inspected by Ops.
- Suspected root cause and candidate files.
- Constraints: tests to run, behavior to preserve, and what not to touch.
- Linkage back to the Ops parent session.

The child owns all file edits, tests, commits, pushes, and PR creation. The Ops
parent can `view`, `wait`, and `message` the child using the existing spawned
session controls, but it cannot read the child's filesystem directly or push its
branch.

### Inline UX

The Ops chat should render a remediation card when a child session is spawned.
It should be similar to the existing `SpawnedSessionCard`, with Ops-specific
context:

- Target repository and branch.
- Diagnosis summary.
- Child status: starting, running, idle, PR opened, CI failing, CI passing.
- Latest child assistant summary.
- PR lifecycle summary when the child opens a PR.

The Host tab can surface read-only source attachments as context, but it should
not add buttons that run commands or mutate state. The user can ask the Ops
agent in chat to attach a repo, inspect a file, or spawn a remediation session.

### Trust boundaries

| Risk | Mitigation |
|---|---|
| Ops mutates production Docker state | Existing read-only Docker proxy remains unchanged. |
| Ops mutates source directly | Source context is read-only; no Git writes from Ops. |
| Ops opens PRs against `ship-it` for users without write access | Orchestrator checks write permission before child creation. |
| Ops leaks private repo contents across users | Repo attach and search are scoped to the current user's GitHub auth. |
| Ops targets the wrong repo | Require explicit `--repo` when inference is ambiguous; show target repo in the remediation card. |
| Agent creates many remediation sessions | Reuse spawned-session quotas, with a lower Ops-specific per-turn default if needed. |
| Logs include secrets | Redact incident packets before passing them to the child session; keep raw logs in the Ops transcript only when already visible there. |

## API and CLI shape

### Read-only repo context

New shim commands, brokered through `agent-ops-routes.ts`:

```bash
shipit repo list [--json]
shipit repo attach --repo owner/name [--ref REF] [--json]
shipit repo search --repo owner/name "query" [--ref REF] [--json]
shipit repo cat --repo owner/name path/to/file [--ref REF]
shipit repo summary --repo owner/name [--ref REF] [--json]
```

Rejected:

- `shipit repo clone`
- `shipit repo edit`
- `shipit repo commit`
- `shipit repo push`
- `shipit repo checkout`
- Any command that exposes credentials or raw Git config.

### Cross-repo remediation spawn

Extend the existing session shim:

```bash
shipit session create --repo owner/name -p "PROMPT" [--title T] [--agent A] [--model M] [--json]
```

Behavior:

- Without `--repo`, existing same-repo spawn behavior stays unchanged.
- With `--repo`, the parent must be an Ops session.
- The target repo must be imported or importable through the user's GitHub
  installation.
- The target repo must be writable for remediation. Read-only repos are valid
  for `shipit repo *`, not for `shipit session create --repo`.

## Implementation plan

1. Add a read-only repo context service in the orchestrator, backed by existing
   GitHub auth and repo cache primitives.
2. Extend the `shipit` shim with `repo` read commands and worker allowlist
   routes.
3. Add orchestrator routes for repo list/search/cat/summary scoped to the
   calling session and current user.
4. Extend `spawnChildSession()` to accept an optional target repo URL when the
   parent session is `kind: "ops"`.
5. Add permission checks: read for repo context, write for remediation spawn.
6. Add an incident-packet builder used by Ops prompts and the spawn route.
7. Add an Ops remediation card in parent chat, reusing the spawned-session
   status pipeline where possible.
8. Update agent-facing docs so Ops agents know the sequence: inspect host,
   inspect code read-only, spawn remediation session, wait/view/message child.

## Key files

| File | Expected change |
|---|---|
| `src/server/session/agent-shim/shipit.ts` | Add `shipit repo *` commands and `shipit session create --repo` parsing. |
| `src/server/session/agent-ops-routes.ts` | Broker read-only repo routes and cross-repo spawn requests. |
| `src/server/orchestrator/services/child-sessions.ts` | Allow Ops-only target repo selection for spawned children. |
| `src/server/orchestrator/services/repos.ts` | Reuse repo import/cache status for read-only context and target validation. |
| `src/server/orchestrator/github-auth-repos.ts` | Add or reuse read/write permission checks for candidate repos. |
| `src/server/orchestrator/api-routes-session.ts` | Thread optional target repo into spawn route with Ops-only validation. |
| `src/server/orchestrator/api-routes-github.ts` or repo routes | Add read-only repo context endpoints. |
| `src/server/shared/types/domain-types.ts` | Add any remediation-card or source-context metadata types. |
| `src/client/components/SpawnedSessionCard.tsx` | Either extend for remediation context or compose a new Ops-specific card. |
| `src/server/shipit-docs/ops-session.md` | Update the agent-facing Ops contract with read-only code investigation and child-session remediation flow. |
| `src/server/shipit-docs/sessions.md` | Document the Ops-only `--repo` remediation spawn behavior. |

## Open questions

1. Should read-only source context be filesystem-mounted snapshots or CLI-only
   access? Recommendation: CLI-only first; add read-only mounts later if the
   agent clearly needs local tooling across attached repos.
2. Should Ops be allowed to spawn into forks automatically when the user lacks
   write access to `ship-it`? Recommendation: not in v1. Require an explicit
   writable repo target so ownership and PR destination are visible.
3. How much raw log context should be copied into the child prompt?
   Recommendation: aggressively trim and redact; link the child back to the Ops
   transcript for full context visible inside ShipIt.
4. Should non-Ops sessions ever get cross-repo spawn? Recommendation: keep it
   Ops-only until there is a separate product need. Cross-repo spawn has a much
   wider trust surface than same-repo fan-out.
