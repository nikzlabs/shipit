---
status: done
priority: medium
description: Each session container only carries the credentials of its pinned agent — a Claude session never has .codex on disk, and vice versa.
---

# Per-agent credential isolation

## Goal

A session running **Claude** must not be able to read **Codex** credentials, and
vice versa. Today every session container can read both, because the orchestrator
mounts one shared credentials directory — containing `.claude/` **and** `.codex/`
— into every container regardless of which agent the session uses.

This doc covers **cross-agent isolation only**. It does *not* attempt to stop the
*active* agent from reading its *own* credential — that is the same-process /
same-uid problem (the agent backend *is* the CLI, and its Bash/Read tool calls run
as the same root user that signs API requests). Solving that requires an egress
broker with scoped ephemeral tokens, which is deliberately **out of scope** here
and tracked as possible future work. The achievable, meaningful guarantee is:
*the credential of the agent you are not using is never present on disk in your
container.*

## Current state (the leak)

- **One credentials surface, mounted into every container at `/credentials:rw`.**
  - Bind-mount path (dev/local): `binds.push(`${config.credentialsDir}:/credentials:rw`)`
    in `container-lifecycle.ts` (`buildMounts`).
  - Volume path (production VPS): a **single global** named volume from
    `process.env.CREDENTIALS_VOLUME`, plumbed through `app-lifecycle.ts` →
    `SessionContainerManager` → `buildMounts`. All sessions share it.
- That surface holds both agents' creds side by side. Confirmed contents of
  `/credentials` in a live container: `.claude/` (incl. `.credentials.json`),
  `.claude.json`, `.codex/`, `.gitconfig`, `shipit-credentials.json`.
- The agent process runs as **root** inside the container, so file permissions
  (`0600 root:root`) do not gate it. A Claude session can `cat /credentials/.codex/...`
  and vice versa.

### Why the obvious fix doesn't work alone

"Just mount the chosen agent's subtree at container-create time" fails for the
**warm pool**: warm containers are created *agent-agnostic*, before the agent is
known. `warm-pool-manager.ts` builds the container (with the shared credentials
mount) up front; the agent (`defaultAgentId`) is only fixed when the session is
claimed / the first message arrives. You cannot add or narrow a bind mount on an
already-running container.

## Key decision: the agent is pinned, but not at session creation

From the **user's** perspective: they pick the agent/model first, then type the
prompt; from that point the agent cannot change. Internally, pinning at *session
creation* is too early — the warm pool means a container may already exist before
the agent is chosen. So:

- **Pin point: the first turn.** When the first prompt is submitted, the agent is
  fixed for the life of the session. `set_agent` is rejected thereafter.
- This is write-once: because the agent never changes after turn one, credentials
  are provisioned exactly once and never swapped, torn down, or revised.

## Design

### 1. Per-session credentials volume (replaces the shared mount)

Instead of mounting the global shared `/credentials` (both agents) into every
container, give each session its **own** credentials volume:

- The per-session volume is mounted at `/credentials` from container boot, but
  starts **empty** (or with only shared, non-secret config like `.gitconfig`).
- Warm containers therefore carry **no agent creds** at all while idle in the pool.
- When the agent is pinned (first turn), the orchestrator populates that session's
  volume with **only the pinned agent's** subtree, copied from the orchestrator's
  source-of-truth credentials:
  - Claude → `.claude/` (incl. `.credentials.json`) + `.claude.json`
  - Codex → `.codex/`
  - Shared → `.gitconfig` (both; not agent-sensitive)
- Because the volume is already mounted at boot, no remount is needed — the
  orchestrator writes into the volume's backing path after the agent is pinned.
  This mirrors how env-based platform credentials are already injected
  (`platform-credentials.ts` / `x-shipit-secrets`), one layer down (files, not env).

Net guarantee: a Claude session's container never has `.codex` on disk at any
point in its lifetime, and a Codex session's container never has `.claude`.

### 2. Server-side `set_agent` lock

`set_agent` (handled in `orchestrator/index.ts`, the WS dispatch `switch`) currently
accepts an agent change at any time and persists it via
`sessionManager.setAgentId(...)`. Add a guard:

- Reject `set_agent` once the session has been pinned (has had its first turn /
  has provisioned credentials). Return a `{ type: "error", message: ... }`.
- Source of truth is the server. The pin state needs a persisted session field
  (e.g. `agentPinned` / derive from "first turn completed"), set when the first
  turn starts, alongside the existing `agent_id` column in `sessions.ts`.

### 3. UI lock (believed already implemented — verify)

`AgentPicker` already has a `disabled` state (opacity/`cursor-not-allowed`
styling), and the agent picker is expected to be disabled once a session is
active. **Verify** the exact trigger matches the server pin point (first turn),
so UI and server agree on when switching becomes impossible. The server rejection
is the authoritative guard regardless; the UI disable is defense-in-depth + UX.

## Touchpoints

- `container-lifecycle.ts` (`buildMounts`) — switch `/credentials` from the shared
  source to a per-session volume; stop mounting agent-cred subtrees at boot.
- `app-lifecycle.ts` / `session-container.ts` — provisioning of per-session
  credentials volumes (creation, naming, teardown). Currently a single global
  `CREDENTIALS_VOLUME`; this becomes per-session.
- New orchestrator step: populate a session's credentials volume with the pinned
  agent's subtree at first turn. Copies from the orchestrator's source-of-truth
  creds (the global credentials dir / AuthManager / codex-auth).
- `orchestrator/index.ts` `set_agent` case — add the post-pin rejection guard.
- `sessions.ts` — persisted pin field; set at first-turn start.
- Disk cleanup — per-session credentials volumes must be dropped on session
  teardown (extend the existing `removeVolumes` / `disk-janitor.ts` paths so the
  new volumes don't leak; they should carry the `shipit-managed=true` label like
  other per-session volumes).
- Client `AgentPicker` / `MessageInput` — confirm/align the disable trigger.

## Open questions to resolve during implementation

- **`.claude.json` and `shipit-credentials.json` contents.** Confirm whether these
  are Claude-only or carry cross-agent-sensitive data, to decide exactly which
  files land in each agent's subtree (and whether `shipit-credentials.json` should
  be mounted at all into a session container).
- **Source-of-truth read path for Codex creds** when populating the volume — mirror
  how `platform-credentials.ts` reads Claude's OAuth token, via `codex-auth.ts`.
- **Warm-pool teardown** of per-session credentials volumes for containers that are
  evicted from the pool unclaimed (never pinned) — should be a no-op cleanup since
  they were never populated, but verify they're labeled and reaped.

## Implementation (shipped)

The isolation is built on a **per-session credentials subtree**, not a separate
Docker volume per session. This mirrors how the workspace volume is sub-pathed
per session and avoids volume proliferation:

- **`session-credentials.ts`** — pure fs helpers:
  - `perSessionCredentialsDir(root, sid)` → `<root>/sessions/<sid>` (orchestrator
    host path).
  - `perSessionCredentialsSubpath(sid)` → `sessions/<sid>` (Docker `Subpath`).
  - `ensureSessionCredentialsScaffold(root, sid)` — mkdir + copy the shared
    `.gitconfig`. Called at container create (incl. warm/standby) so an idle
    container carries **no agent creds**.
  - `provisionAgentCredentials(root, sid, agentId)` — copy ONLY the pinned
    agent's subtree (`.claude` + `.claude.json`, or `.codex`) plus a fresh
    `.gitconfig`. `shipit-credentials.json` is deliberately **not** copied — the
    agent gets its env via the 087/088 agent-env push, not by reading that file.
  - `removeSessionCredentials` / `sessionCredentialsRoot` — teardown helpers.
- **`container-lifecycle.ts`** — `createContainer` scaffolds the per-session dir;
  `buildMounts` mounts `<credentialsDir>/sessions/<sid>` at `/credentials` (bind
  in dev, volume `Subpath` in prod) instead of the shared root. The image's
  `~/.claude` / `~/.codex` symlinks resolve into this private subtree.
- **First-turn pin** — `runAgentWithMessage` (`agent-execution.ts`) pins the agent
  on the first turn for *every* runner type (sets `agent_id` + `agent_pinned`),
  and for container runners also provisions the agent subtree **before**
  `/agent/start`. Write-once: skipped once `agentPinned` is set, so the CLI's
  in-place writes to `.claude` are never clobbered.
- **`set_agent` lock** — `index.ts` rejects a switch to a *different* agent once
  `agentPinned` is set (re-selecting the same agent is a no-op). UI lock
  (`ModelAgentSelector` disabled via `hasActiveSession`) is defense-in-depth.
- **Schema** — migration 14 adds `sessions.agent_pinned`; `SessionManager`
  exposes `setAgentPinned()` and surfaces `SessionInfo.agentPinned`.
- **Cleanup** — `disk-janitor.ts` `sweepOrphanCredentialDirs` removes subtrees for
  archived/untracked sessions on startup; `fullReset` drops the whole
  `<credentialsDir>/sessions` tree (top-level source-of-truth creds preserved so
  reset doesn't sign the user out).

### Resolved open questions

- **`.claude.json` / `shipit-credentials.json`** — `.claude.json` is Claude-only
  and is copied for Claude sessions. `shipit-credentials.json` is **not** mounted
  into session containers at all (it never needed to be — agent env arrives via
  the agent-env push), which also shrinks the secret surface.
- **Codex source-of-truth** — `.codex/` is copied straight from the credentials
  root (where `codex login` writes it), same as Claude's `.claude/`.
- **Warm-pool teardown** — unclaimed warm sessions only ever get the `.gitconfig`
  scaffold (no agent creds), and the janitor reaps the subtree once the session
  is archived/deleted.

### Known limitations

- **`.gitconfig` token freshness** — the GitHub token is embedded in the copied
  `.gitconfig` credential helper. It's refreshed at scaffold (container create)
  and at pin (first turn), so it's current when the first push happens. A token
  *rotated mid-session* won't propagate to the already-copied per-session
  `.gitconfig` until the container is recycled. Orchestrator-side pushes always
  use the live root `.gitconfig`, so only in-container agent `git push` is
  affected — an accepted, rare edge case.
- **In-flight containers across deploy** — containers created before this change
  still mount the shared root; they pick up the per-session mount when recycled
  (idle eviction / restart). Not a correctness regression (matches old behavior).
- **Local/test mode** — no containers, so no per-session mount; the agent is
  still pinned (so `set_agent` locks), but credential provisioning is a no-op.

## Out of scope

- Stopping the active agent from reading its own credential (broker / scoped-token
  egress proxy). Noted only so it isn't re-litigated here.
