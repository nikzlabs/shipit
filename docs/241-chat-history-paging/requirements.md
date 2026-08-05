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

## Open questions

- **Window bounds beyond the turn count.** Req 2 fixes the window at ~10 turns.
  A turn can be arbitrarily large (a 40-tool-call turn is ~40 stored rows), so
  should the window also carry a row floor and cap — e.g. never fewer than ~50
  rows so a short turn still fills the screen, never more than ~500 so one
  runaway turn cannot pull in most of the transcript? *Recommendation: yes,
  floor ~50 and cap ~500, with the currently-running turn exempt from the cap.*
- **Should the user be able to see that a window exists?** The design currently
  makes it invisible. Review argued that every failure mode — slow page, failed
  fetch, reconnect — then looks identical to "my conversation is gone", and
  proposed a visible element at the top of the loaded portion (label → spinner →
  "couldn't load earlier messages · retry"), plus a "jump to latest" control
  once the user is deep in the scrollback. *Recommendation: yes to both; a
  silent stop is indistinguishable from data loss.*
- **Must scrolling-up progress survive a reconnect?** Today every tab
  focus/foreground event refetches history and replaces the transcript, which
  would discard everything the user scroll-loaded. Req 3 does not say whether
  that progress must persist. *Recommendation: yes, preserve it — otherwise
  backgrounding the tab for a few seconds silently undoes req 3.*
- **Is navigating a long session in scope?** Separate from loading it: "get me
  back to the turn where the second PR opened". Paging slightly worsens it,
  since older content must be fetched before it can be scrolled to or searched.
  `docs/104-chat-toc-and-summaries` is an existing plan-only design for this.
  *Recommendation: out of scope here; decide separately once the window ships.*

## Resolved questions

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
