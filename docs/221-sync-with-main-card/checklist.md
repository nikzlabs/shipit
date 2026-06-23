# 221 — checklist

- [x] `GitManager.forceUpdateBranchRef` (`git branch -f`, no checkout) + `getRefHash`
- [x] `runRebaseFlow` fast-forwards local `<base>` to `origin/<base>` (`syncLocalBaseRef`)
- [x] Persisted `BranchSyncedCard` wired end-to-end (type → WS → column + migration → toRow/fromRow → client handler → React card)
- [x] Card emitted only when something changed; gated on manual route (`recordSyncCard`)
- [x] `WsRebaseComplete.baseMoved` suppresses the "Already up to date" toast when local base moved
- [x] Tests: git ref-move, rebase-driver sync card + base move, card persistence round-trip, client handler
- [x] typecheck + lint:dev clean
- [ ] Live verify in dogfood preview (manual): click Sync with main on a behind session, confirm local main advanced + card survives reload
