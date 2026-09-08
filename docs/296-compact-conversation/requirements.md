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
- Browser Find and select-all behavior is an open question below, not an approved exception.
- Keep chronological order, including cards before the final reply. Do not collect cards into a new end-of-turn tray.

## Open questions

Before production implementation, decide whether compact mode may limit browser Find and select-all to displayed content. [The existing contract](../265-transcript-render-cost/requirements.md) records a user decision to keep both complete. The proposed exception would apply only while this optional view is enabled; disabling it restores full scope, and in-app search still finds hidden message text. Keeping nodes mounted but hidden does **not** by itself preserve browser Find or select-all. If the existing contract must also hold in compact mode, prototype and verify a browser-compatible reveal/copy design before implementing it.

The other proposed defaults above are conservative design recommendations for review, not additional requests attributed to the user.
