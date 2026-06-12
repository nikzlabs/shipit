# Checklist — Multi-agent CLI v0

- [x] Extract provider-agnostic `AgentProcess` / `AgentCapabilities` interfaces.
- [x] Normalize agent events so the server and client render Claude and Codex turns through the same path.
- [x] Refactor Claude behind the adapter interface without regressing the existing flow.
- [x] Implement the Codex App Server adapter using JSON-RPC over stdio.
- [x] Map Codex assistant messages, tool calls, file changes, turn completion, and rate-limit events into normalized ShipIt events.
- [x] Add Codex tool-name mapping for activity labels and chat rendering.
- [x] Add Codex session/thread resume support through `thread/resume`.
- [x] Add agent picker / active-agent plumbing so sessions can run with Codex.
- [x] Cover Codex adapter behavior with unit tests.
- [x] Cover Codex message flow and agent switching with integration tests.
- [x] Document that Gemini is postponed until its CLI has session-management support.
