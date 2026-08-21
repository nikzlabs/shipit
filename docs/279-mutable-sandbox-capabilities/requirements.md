---
title: Sandbox capabilities are editable after creation
description: A sandbox session's GitHub / merge / Docker / Network grants can be changed after the session exists, applying live where possible and pending a container restart where not — the same behaviour the per-session egress mode already has.
---

# Sandbox capabilities are editable after creation

Today a sandbox session's capability set (`git`, `dangerousGitHubOps`, `docker`,
`network`) is chosen once in `SandboxDialog` at creation and is immutable
afterwards (docs/211-sandbox-sessions, docs/224-sandbox-merge-capability). The
only way to change a grant is to throw the session away and start a new one,
losing its workspace and chat history.

1. A sandbox session's capabilities can be changed **after** the session is
   created. The creation dialog stops being the only place they are chosen.
2. A capability change that the session's **live container can honour** takes
   effect straight away — no restart, no new session.
3. A capability change the **live container cannot honour** is still saved, and
   the surface says it is **pending until the next container start** and offers
   an action to restart now. This is the behaviour the per-session egress mode
   already has (`SessionSettingsDialog` + `EgressSessionSettings.pendingRestart`,
   docs/172-agent-containment) and it is what a sandbox capability change must
   reuse — including its rule that the restart is never automatic and is refused
   while an agent turn is running.
4. Capabilities stay **server-authoritative**: the change is a user act from the
   browser, and the agent inside the container still cannot grant itself a
   capability. (Inherited from docs/211, not new — but it constrains where the
   route may live: the edit endpoint must not be container-accessible.)

## Open questions

- **Where does the editor live?** The per-session overflow menu already has a
  "Session settings" item that opens the egress dialog; a sandbox also shows the
  `SandboxBanner` in the chat panel, which already lists the granted set.
- **Revoking Docker while the agent has containers running.** Restarting the
  agent container un-plumbs `DOCKER_HOST`, but the containers/networks/volumes
  the agent already created stay running until the session is archived. Does a
  revoke leave them alone, or tear them down?
- **Does a capability change leave a record in the chat transcript?** The egress
  mode change leaves none, and the sandbox banner is deliberately derived chrome
  rather than a persisted card (docs/211) — but a grant change is a trust-boundary
  change, which is the usual argument for a durable record.

## Resolved questions

- 2026-08-21 — *If applying a change needs a container restart, what should
  happen?* Nik: the same behaviour as the egress settings on a regular session —
  save it, mark it pending, offer "Restart to apply now". Recorded as req 3.
