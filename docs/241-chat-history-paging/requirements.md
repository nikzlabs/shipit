# Windowed chat-history loading

1. Opening a session loads only a recent portion of the transcript, not the
   whole conversation.
2. The portion loaded initially is the latest ~10 full turns.
3. The user can load older parts of the conversation by scrolling up.
4. In-chat search still covers the whole conversation, automatically loading
   older parts as needed.
5. Downloading the chat still exports the whole conversation, not just the part
   currently loaded.
6. A loaded portion never begins in the middle of a grouped set of tool calls;
   it continues back to the nearest user message instead.
7. The transcript shows when older messages exist above the loaded portion,
   when they are being loaded, and when loading them failed — with a way to
   retry. A window that stops early is never silently indistinguishable from
   the start of the conversation.
8. The user can get back to the latest messages without scrolling all the way
   down.

## Open questions

- **Must scrolling-up progress survive a reconnect?** Today every tab
  focus/foreground event refetches history and replaces the transcript, which
  would discard everything the user scroll-loaded. Req 3 does not say whether
  that progress must persist. *Recommendation: yes, preserve it — otherwise
  backgrounding the tab for a few seconds silently undoes req 3.*
## Resolved questions

- 2026-08-05 — *Should the ~10-turn window also carry a row floor and cap?*
  Chosen: **no — turn count only.** No requirement changed; this rules the extra
  bounds out of scope. It also simplifies the design: with no cap there is no
  "snap forward past the cap" case, and therefore no way for a window to cut a
  running turn (see `plan.md` §2–§3).
- 2026-08-05 — *Should the user be able to see that a window exists?* Chosen:
  **yes — a visible seam plus a jump-to-latest control.** Became reqs 7 and 8.
- 2026-08-05 — *Is navigating a long session (a table of contents / per-turn
  summaries) in scope?* Chosen: **out of scope here; decide separately once the
  window ships.** No requirement changed; `docs/104-chat-toc-and-summaries`
  stays shelved for now.
- 2026-08-05 — *Window unit: a fixed message count, or whole turns?* Chosen:
  whole turns, ~10 (req 2). The stated rationale at the time — that a mid-turn
  cut orphans tool results and cards — was **wrong**: persisted rows are
  self-contained. The choice still stands, but on the corrected ground that a
  mid-turn cut misreports grouped tool calls (see req 6).
- 2026-08-05 — *Must in-chat search cover the whole conversation, or only what
  is loaded?* Chosen: the whole conversation, by auto-loading older parts while
  searching (req 4).
- 2026-08-05 — *Should "download chat" export everything or just the loaded
  part?* Chosen: everything (req 5).
- 2026-08-05 — *Is lazy-loading heavy row bodies part of this feature?* Chosen:
  no — paging only, with a separate issue filed for fields not directly
  displayed in the conversation UI. That became SHI-267, which has since
  **landed** as `docs/244-lazy-tool-result-bodies`. No requirement here changes;
  the two features compose (see `plan.md`).
- 2026-08-05 — *Doesn't gzip already solve the traffic half at the transport
  level?* Largely yes on the hosted path, which is fronted by a Cloudflare
  tunnel. No requirement changed: this corrected the design's justification
  (the remaining cost is per-row work, not bytes) rather than what the feature
  must do.
- 2026-08-05 — *What happens if a window opens in the middle of a group of tool
  calls?* Raised by the user; became req 6 (continue back to the nearest user
  message).
