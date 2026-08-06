# 221 — checklist

- [x] `GitManager.forceUpdateBranchRef` (`git branch -f`, no checkout) + `getRefHash`
- [x] `runRebaseFlow` fast-forwards local `<base>` to `origin/<base>` (`syncLocalBaseRef`)
- [x] Persisted `BranchSyncedCard` wired end-to-end (type → WS → column + migration → toRow/fromRow → client handler → React card)
- [x] Card emitted for every manual sync (including already-current); automatic conflict resolution remains cardless
- [x] `WsRebaseComplete.baseMoved` suppresses the "Already up to date" toast when local base moved
- [x] Tests: git ref-move, rebase-driver sync card + base move, card persistence round-trip, client handler
- [x] typecheck + lint:dev clean
- [ ] Live verify in dogfood preview (manual): click Sync with main on a behind session, confirm local main advanced + card survives reload

## Follow-up — the agent was never told

- [x] `sessions.pending_agent_notice` column + `setPendingAgentNotice` / `consumePendingAgentNotice` (read-and-clear, exactly-once)
- [x] `runRebaseFlow` records `buildBranchSyncAgentNotice` on the two paths where the branch actually moved (clean + conflicts-resolved), gated on `recordSyncCard`
- [x] `POST /branch/reset-to-base` records `buildManualResetAgentNotice` when no turn is in flight (the merged fork of the same menu item)
- [x] `runAgentWithMessage` drains the notice into the next prompt, ahead of the docs/218 reset prefix; skipped for `/compact`
- [x] Tests: driver unit (recorded / not recorded / no-move), route unit (UI vs agent caller, throw is non-fatal), sessions round-trip + last-write-wins, rebase-flow integration (prompt carries it once)
