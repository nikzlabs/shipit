---
issue: planning#473
title: Fleet coordination — attention queue, control API, voice coordinator
description: One voice channel, mediated by a coordinating agent, to review and steer every session across every repository.
---

# Fleet coordination

Requirements as stated by the user (Nik), captured 2026-08-23 from a voice-dictated design conversation. Statements are what the feature must do — never how.

1. The user must not need to scan or click through the session list to find work that needs them. ShipIt tells them what needs attention.
2. Each attention item tells what happened, gives a short summary in the source agent's own words, and names the decision needed.
3. The workflow works by voice, away from the screen, over one channel that covers every session in every repository.
4. Items wait for the user. The user reviews when they have time; responding at arrival time is never required.
5. The user can hear what needs attention and give feedback by voice, item by item.
6. A spoken decision must carry enough context to decide by ear alone. When a summary is not enough, the user can discuss the item in full, conversationally, by voice, with the session that raised it.
7. The user can ask for overviews by voice: across all work, and per repository.
8. The user can dispatch new work by voice: continue work in an existing session, and start new sessions, several in parallel.
9. One assistant manages all ShipIt work with the user.
10. ShipIt exposes an API so a coordinating agent can do this. ShipIt sends everything to the coordinator and does not gate what reaches the user.
11. The coordinator has explicit presence. The user signals when they are ready to talk. While they are engaged on one topic, other interruptions do not come through. When the user becomes free, the next waiting message plays.
12. Coordination behavior stays in the agent, flexibly, until the user has learned the workflow in practice. Only patterns that prove stable get hardened into code later.
13. The coordinating agent is built into ShipIt and ships from day one. The workflow must not depend on an external assistant.
14. Voice and desktop are one continuous conversation with the same coordinator. At the desktop the user sends text and sees results rendered conveniently in the chat UI; away from it, the same conversation continues by voice.

## Open questions

- If an external assistant is ever attached as a second API client, what capability isolation does its platform enforce? (Decides how much of the untrusted-content boundary is structural rather than instructional. Not blocking: the first client is built-in, req 13.)

## Resolved questions

- 2026-08-23 — May a voice reply trigger a PR merge? No for v1; it has its own risks. Yes in the final vision ("merge water reflections" is the target workflow).
- 2026-08-23 — Push or pull? Pull-first: the user initiates reviews and items wait (req 4). ShipIt pushes everything to the coordinator (req 10); the coordinator owns interrupt and delivery policy through its presence states (req 11). ShipIt holds no interrupt setting.
- 2026-08-23 — Is a headline-plus-one-shot-reply loop enough, without an agent in the middle? No. Tested live in this conversation: a headline could not carry a design decision. A conversational coordinating agent mediates the channel (req 6, 9).
- 2026-08-23 — Native coordinator or external assistant? An API for a coordinating agent comes first ("we need an API for an agent to be able to work with ShipIt"). The external assistant is the expected first client; built-in-from-the-start remains open. *(Superseded the same day — see the next receipt.)*
- 2026-08-23 — External assistant (Hermes) or built-in coordinator as the first client? **Built-in, from day one** (req 13). Reasons, in the user's words: full control of the agent's prompt and environment gives the best experience; at the desktop the user continues the same coordinating agent through the chat UI (req 14); delegating to an existing agent would be a subpar experience; ShipIt already has all the infrastructure. The work splits into two tracks: the agent-agnostic control API (req 10, unchanged), and the built-in coordinator as its first client — external assistants remain possible later.
- 2026-08-23 — How much coordination mechanism belongs in the API? As little as possible now. Doing too much programmatically before the workflow is learned is the wrong way; the agent coordinating is the most flexible thing. Harden observed patterns later (req 12).

## See also

- `api-proposal.md` in this folder — pre-plan design draft for the control API (server substrate, endpoint surface, auth, push). Subordinate to this document.
