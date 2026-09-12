# Checklist — broken-workspace visibility

- [x] `SessionInfo.workspaceBlock` (a bare `WorkspaceBlockKind`), `sessions.workspace_block` migration, `fromRow`
- [x] `SessionManager.setWorkspaceBlock` — returns whether the stored value changed
- [x] `filterVisibleInSidebar` exemption (req 1), cap-aware tests beside the existing ones
- [x] Janitor records the block on a reasoned `blockedEvict`; withdraws it on a push-only block
- [x] Janitor clears on the durable path **and** after `setDiskTier("evicted")` — an evicted session is never revisited (req 6)
- [x] `restoreSessionWorkspace` clears the marker a fresh clone cannot still deserve
- [x] `onSessionsChanged` → `sseBroadcast("session_list", …)`, fired only on a real change
- [x] `postTurnCommit` clears only when the auto-commit held nothing back **and** git reports no rebase/merge/sequencer state — a clean tree with unfinished sequencer state is the incident's own shape
- [x] `runPostInterruptCommit` carries the broadcaster, so the interrupt path's clear is published
- [x] `computeAttentionReason` reason + placement: below `muted` and `awaitingPermission`, above the running/background and `resolved` short-circuits (reqs 3–5)
- [x] Reason table is `Record<WorkspaceBlockKind, string>`, so a new kind cannot ship unnamed (req 2)
- [x] `useAttentionSessions` / `useAttentionNotifications` / `SessionItem` pass the kind through
- [x] Each new guard proven red with its production change reverted
- [x] Independent review; the four clearing/visibility gaps it found are fixed and guarded
- [x] `npm run typecheck`, `npm run lint:dev`, `npm test`
- [ ] Follow-up: a click-to-repair action on the surfaced state — planning#533
