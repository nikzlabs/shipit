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
- [ ] Confirm with the reporter that the transcript survives a mid-turn switch on the deployment

Deferred, tracked in `plan.md` → "Why not reconcile at turn end":

- [ ] Track the running turn's start index client-side so a `final: true`
      snapshot can reconcile a finished turn without duplicating live-streamed
      rows, steered bubbles, and cards
