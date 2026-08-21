# Codex implied implementation intent

1. Codex must execute an implied implementation action when a confirmation-shaped question clearly continues an active change task and the action is safe, reversible, and already in scope.
2. Codex must answer genuine information-only questions without changing project state.
3. Codex must not infer authorization for ambiguous, destructive, externally consequential, or out-of-scope actions, or actions requiring a material user choice.
4. The fix must be an instruction-level change, not a new runtime subsystem.
5. Claude's effective instruction variant must remain unchanged.
6. Regression coverage must verify both the Codex instruction and the Claude exclusion.
7. Codex must not end an active change turn merely because an in-scope review, validation, or completion gate is pending; it must surface progress and continue through the remaining requested deliverables unless it genuinely needs user input or new authority.
8. When a review Codex requested returns findings — including a review it obtained from another backend — Codex must act on them in the same turn rather than reporting them and stopping: fix the findings that are real and say which ones it is not acting on and why. It may pause on an individual finding whose fix needs a decision or authority it does not have, and must still act on the rest.

## Open questions

None.

## Resolved questions

- 2026-08-02 — The user supplied the action boundary directly: safe, reversible, already in scope, and clearly implied by the conversation. Requirements 1–3 record that boundary.
- 2026-08-02 — The user requested the smallest prompt/instruction change and no runtime subsystem. Requirement 4 records that constraint.
- 2026-08-02 — After observing that Codex stopped at the review gate and required a ping, the user requested improving that behavior in the same PR. Requirement 7 records the agent-side continuation behavior; the separate cross-backend UI status is tracked in planning#277.
- 2026-08-02 — The user reported that Codex is often stuck after requesting a review from Claude: it reports the findings and stops instead of fixing them. Requirement 7 covered only the *pending* gate, not the returned result, so requirement 8 records the post-result behavior. The user stated the goal ("instead of fixing them") without specifying blanket-fix vs. triage; requirement 8 assumes triage-and-explain — a reviewer's finding can be wrong, and silently applying every one would be worse than the reported behavior — with a narrow carve-out for findings needing authority Codex lacks, matching requirement 3's boundary.
