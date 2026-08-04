# Checklist

- [x] `WsTurnSnapshot` type + registration in the `WsServerMessage` union
- [x] `attachToRunner` sends the snapshot in the same synchronous block as the listener subscribe
- [x] Drop `agent_event` (and buffered `turn_snapshot`) from the attach replay loop
- [x] `ChatMessage.inProgress` + carry it through `loadSessionHistory`
- [x] Client `turn_snapshot` handler (replace-not-append), registered + transcript-scoped
- [x] Queue `turn_snapshot` behind `historyLoaded` in `useMessageHandler`
- [x] Integration tests for both sampling orders + the no-running-turn case
- [x] Client handler tests
- [x] Retarget the `ws-disconnect-resilience` replay assertion to the invariant
- [x] Gate the `agent_self_wake` reset on `!runner.running` so a mid-turn
      background-task notification stops deleting the running turn's rows
- [x] Integration test for the mid-turn notification + the genuine self-wake
- [x] Confirm with the reporter that the transcript survives a mid-turn switch on the
      deployment — it did not on *window reactivation*, which surfaced the third bug below

Follow-up — window reactivation, `plan.md` → "Third bug":

- [x] Coalesce the `visibilitychange`/`focus`/`pageshow` reactivation burst into
      one reconnect (`FOREGROUND_COALESCE_MS`)
- [x] `historyLoadSeq` — a superseded `loadSessionHistory` writes nothing (not
      the transcript, not `historyLoaded`)
- [x] `agent_result` clears `inProgress` on the client, mirroring the server's
      `finalizeInProgress`, so the snapshot's replace-filter can only touch the
      running turn
- [x] Tests for all three (overlapping loads, finished-turn rows surviving a
      later snapshot, one socket per reactivation)
- [ ] Confirm on the deployment that reactivating the browser window mid-turn no
      longer drops messages

Deferred, tracked in `plan.md` → "Why not reconcile at turn end":

- [ ] Track the running turn's start index client-side so a `final: true`
      snapshot can reconcile a finished turn without duplicating live-streamed
      rows, steered bubbles, and cards
