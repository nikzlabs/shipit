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
5. The capabilities are editable from the per-session **Session settings**
   dialog, and the **sandbox banner**'s granted list is a second entry point
   into that same dialog.
6. Revoking a capability removes the agent's **access** and destroys nothing it
   already made. The revoke itself writes a grant and runs no teardown; what
   happens to the containers, networks and volumes an agent created stays
   governed by the existing container lifecycle, unchanged by this feature.
   (Amended 2026-08-21 after review: the original wording said they "keep
   running until the session is archived", which overstates it — the restart
   this feature offers, and idle container disposal, both already reap them.
   The requirement is about the revoke, and that is what the wording now says.)
7. A capability change writes a **persisted chat card** into the session's
   transcript, so the trust boundary moving is visible in the scrollback and
   survives reload.
8. The same persisted card is written when a **regular** (non-sandbox) session's
   network access is changed from the Session settings dialog. That change is
   silent today.

## Open questions

None.

## Resolved questions

- 2026-08-21 — *If applying a change needs a container restart, what should
  happen?* Nik: the same behaviour as the egress settings on a regular session —
  save it, mark it pending, offer "Restart to apply now". Recorded as req 3.
- 2026-08-21 — *Where does the editor live?* Nik: the Session settings dialog,
  with the sandbox banner linking into it. Recorded as req 5.
- 2026-08-21 — *Revoking Docker while the agent has containers running — leave
  them or tear them down?* Nik: leave them alone. Recorded as req 6.
- 2026-08-21 — *Does a capability change leave a record in the chat transcript?*
  Nik: yes, a persisted card — "and the same for granting internet access for
  regular sessions". Recorded as reqs 7 and 8.
