---
status: planned
priority: medium
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

## Out of scope

- Stopping the active agent from reading its own credential (broker / scoped-token
  egress proxy). Noted only so it isn't re-litigated here.
