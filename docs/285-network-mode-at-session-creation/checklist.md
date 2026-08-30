# Network mode at session creation — implementation

- [x] `EgressEnforcementStatus` — report WHICH inactive deployment it is, since the two cases point in opposite directions
- [x] Strict validation on both session egress routes (unknown id → 404, bad `override` → 400)
- [x] No audit card for the creation-time choice; a card for every later change
- [x] `reconcileSessionEgress` — compare the resolved mode against the raw `egressContainedAtStart`, restart on disagreement
- [x] `restartContainer` gains `resetBreakers` / `agentSeed`; reconciliation takes neither of Rescue's privileges
- [x] `withFirstTurnAdmission` — session-keyed section covering competing first Sends **and** the override PUT
- [x] `turnStartInProgress` — a pre-spawn reservation `verifyRunningState()` cannot clear
- [x] First-Send reconciliation wired into `send-message.ts`, released in a `finally` around the whole handler
- [x] Quick Capture: `networkMode` through the request, persisted and reconciled before `getOrCreate`, with the agent seed
- [x] Interactive claim resets a reused draft's override (req 8)
- [x] Runner incarnation in the `active_runners` snapshot + live `runner_replaced`, so a second viewer converges
- [x] Combined flat control: Permission mode + Network access, one trigger, every viewport
- [x] Mode leaves `ComposerSettingsMenu`; the role root collapses onto the role list (req 9)
- [x] `useSessionNetworkMode` / `useComposerNetworkMode` — shared mutation clock, pre-claim draft, Send barrier
- [x] `session_egress_changed` invalidation; the global egress fields stay fresh without the Settings editor
- [x] Session settings dialog: shared copy, one name for one value, enforcement warning that names the case
- [x] Tests: reconciliation states, admission lock, the combined control, route validation, req 8 through the reuse path
