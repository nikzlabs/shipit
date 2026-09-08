---
title: Compact conversation view — requirements
description: An optional view that keeps completed turns short while preserving results and cards.
---

# Compact conversation view

## User request

Provide a setting, off by default, that shows only the last agent message and relevant cards for each finished turn. Keep context compaction, ShipIt and native sub-agent activity, questions, and proposed actions visible. This request covers design, a visual mockup, and a ShipIt review; production implementation is separate.

## Required behavior

1. The user can enable or disable the view in Settings. New users see the full view.
2. Completed turns show their last agent message. User messages and attachments remain visible.
3. Relevant cards remain visible and usable, in their original order. This includes context compaction, native sub-agents, ShipIt child sessions, reviews, questions, permissions, actions, presentations, and release results. The session PR panel stays in its existing location outside the transcript.
4. Ordinary tool calls, tool results, and intermediate agent prose are hidden in compact completed turns.
5. Active turns remain fully visible. A pending question must remain answerable.
6. The user can reveal one full turn without changing the setting. Disabling the setting restores the full conversation. No history is deleted or rewritten.
7. Failed or interrupted turns keep their status and errors visible. If no agent prose exists, a neutral status replaces it; never imply success from missing text.
8. Reload, reconnect, session switching, queued messages, and late cards must not hide unfinished work or move content between turns.

## Proposed design decisions (not user requirements)

- Keep all existing transcript cards in version one. Do not guess relevance from text or use an LLM filter.
- Store the preference for this browser, across sessions, like other display preferences. No repository or agent setting is changed.
- Preserve the existing in-app search scope: message text, including hidden progress prose. Tool inputs/results and card bodies are not newly searchable.
- Browser Find and select-all cover displayed content while compact mode is enabled. The user approved this scope on 2026-09-08. Switching compact mode off restores the full scope.
- Keep chronological order, including cards before the final reply. Do not collect cards into a new end-of-turn tray.

## Resolved decisions

2026-09-08: The user chose “Allow displayed content only” in response to the browser Find/select-all question. The opt-in compact view may limit these to displayed content; full view retains its existing contract. In-app search retains its existing message-text scope, including hidden progress prose.

The user also requested realistic card layouts based on existing components, and the Claude Light theme for the mockup. Generic expandable card shells are not part of the design.

## Open questions

None for this design.
