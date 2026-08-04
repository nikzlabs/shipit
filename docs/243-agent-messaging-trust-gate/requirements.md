# Requirements

1. Until the user clicks the existing “Trust this repository” button, messages to the agent are blocked for that repository.
2. The chat send button must be disabled while the repository is untrusted.
3. The server must independently enforce the block; disabling the client is not the security boundary.
4. The existing Trust action is the consent that enables agent messaging.
5. Ops and sandbox sessions are exempt from the repository messaging trust gate.
6. The Trust action must be reachable in every mode the gate is active in, including modes that render no Preview tab. Both the Preview surface and a surface attached to the composer carry it.

## Resolved questions

- **2026-08-04 — Where does the trust surface appear when the user is off the Preview tab?**
  Asked because the Preview-only placement made local mode (dogfood) a dead end: the composer was blocked by this gate with no reachable consent. Answer: **keep both** — the existing Preview banner stays, and the composer-adjacent notice carries its own Trust action. This supersedes the earlier "keep the existing Trust action as the *only* consent action" decision, which had been recorded before the dead end was known. Recorded as requirement 6.
