---
title: Compact conversation view — design
description: A display preference that hides finished-turn detail and keeps cards in place.
---

# Design

See [requirements](./requirements.md) and [interactive mockup](./mockup.html). This is a design proposal, not an implemented feature.

## Experience

Add **Conversation** under Settings → Advanced, next to other local preferences. Label: **Compact completed turns**. Help: “Show the last agent message and all cards. Hide tool output and progress messages in finished turns.” Default off. Add a short note: “Saved for this browser. In-app search includes hidden messages. Browser Find behavior is pending a design decision.” Reuse the existing toggle. A new settings tab for one switch is unnecessary.

Each eligible turn gets a quiet “Show full turn” control before its content; when expanded it reads “Show compact turn”. Only show it when something can be hidden. The control is a real button with aria-expanded and aria-controls. Expansion is local to that session visit. Use the current row anchor; reset expansion when history is replaced or rewound so an index cannot transfer expansion to unrelated content. All user content stays in place, including messages sent while the agent was working. An active or uncertain turn has no collapse control.

Keep the last non-empty ordinary assistant message, with its complete markdown, code, images, and attachments. Retain any message with images or files whole, including its prose. Preserve all cards and errors/notices. Apply visibility at the existing visual-element boundary, where native standalone tools can be retained even when ordinary tools are hidden. Card carrier rows already render separately; do not add sub-row attachment filtering or invent a mixed-card data format. Questions and native sub-agent tools render as standalone elements today and must not pass through an ordinary-tool filter. Do not truncate card contents beyond their existing renderer behavior.

Final means the last ordinary agent prose in a settled turn, not the last array entry and not an assumption that the adapter supplies a final channel. A stopped or failed turn keeps its existing status/error plus that last prose. Without prose, show “Turn ended without an agent reply” alongside the actual outcome if known. An unclassified legacy turn remains full; do not invent a success label.

Late review, child-session, or action cards stay wherever the existing history inserts them. Post-turn cards can be appended after later user messages. The session PR panel remains outside the transcript, as rendered in App.tsx; only release cards are inline. They do not reopen hidden prose or become the final agent reply. Cards outside a turn stay visible. Existing card renderers own current action state, including resolved or cancelled state; folding a turn must not reset a form or repeat an action.

## Data and implementation boundaries

Verified at `src/client/components/visual-elements.ts`: standalone tools and the card registry already distinguish special content from ordinary tools. Verified at `MessageList/types.ts:ChatMessage`: inProgress differs from streaming, and there is no general turnId field. Verified at `MessageList/cards/MessageCards.tsx:renderMessageCard`: card rendering includes both child sessions and brokered consults. Verified at `Settings/tabs/AdvancedTab.tsx:NotificationSettings` and `hooks/useTheme.ts`: local display preferences already have an established location and storage pattern.

Use conservative client-only assistant runs, following the existing Play-button grouping in MessageList.tsx, but do not reuse its streaming-only completion test. A user message may split one real turn: accepting two retained prose messages is safer than hiding content across that boundary. Only fold runs proved settled; inProgress and streaming always prevent folding. Trace the live path before implementation: if flags do not mark all current-turn rows, keep all rows added since the active-turn start visible. On attach during a running turn, leave uncertain runs full until settlement. No server migration or new persistent turn identity is part of this feature.

Keep hidden rows mounted and counted in the existing ROWS_PER_GROUP buckets; hide their content without changing anchor counts or DOM parents. Verified at MessageList.tsx:rows.forEach, these counts define content-visibility groups. This prevents toggling an old turn from remounting later cards. Retain all card state. Preserve the assistant-side rewind gap independently of the first prose bubble: TranscriptRow places that gap inside the row that compact mode would otherwise hide. Its placement must remain before the response, even when the first prose is hidden.

Keep original message references and history unchanged for speech, copy/export, reply, and rollback. Verified at useSearch.ts, in-app search matches msg.text, not tool output or card bodies. While a search query is active, reveal runs with message-text matches before existing scroll/highlight behavior. No persistent per-match reveal state is needed. Browser Find/select-all remain the explicit open question in requirements.md; mounted hidden nodes do not solve that question.

Preserve the visible reading anchor on toggle or settlement; only follow the bottom when the reader was already there. Explicit collapse returns focus to its disclosure. Automatic settlement must not remove focused or selected content: defer that run's collapse until focus/selection leaves. This small guard remains because selection during a live turn is an established supported behavior.


## Key files to examine/change during implementation

- `src/client/stores/settings-store.ts`: local preference, safe default and storage failure handling.
- `src/client/components/Settings/tabs/AdvancedTab.tsx`: setting and help text.
- `src/client/components/visual-elements.ts`: explicit visibility classification, keep unknown cards visible.
- `src/client/components/MessageList/MessageList.tsx` and `TranscriptRow.tsx`: projection, disclosure, scroll/focus handling.
- `src/client/components/MessageList/types.ts` and live turn handlers: verify existing active-row signals; no new persistence metadata.
- `src/client/hooks/useSearch.ts`: reveal before match navigation; retain raw-history search.
- Existing card rendering and transcript round-trip tests: card preservation and identity.

## Verification before production

Cover off-by-default persistence; completed/active/error/no-prose turns; two turns without commits; steered and queued input; mixed text/tool/card rows; native Agent/Task tools; pending/resolved questions and actions; late cards; reload/reconnect/session switch; hidden prose search matches; preserved rewind controls and row-group parents; keyboard disclosure; selection and scroll stability; narrow and wide screens; all registered themes, with visual checks in representative light and dark themes. Guard unknown cards so adding a type cannot silently hide it. Use affected component tests, lint:dev, typecheck, and browser checks when implementation begins.

## Simpler alternatives

A single global toggle with no per-turn reveal saves one control but makes inspection costly. Filtering only ordinary prose is insufficient because native sub-agent and question tools have their own visual elements. Moving all cards after the reply changes chronology. AI relevance scoring adds delay and unpredictable omissions. Keep visibility flags on existing elements and existing card renderers.

## Mockup scope

The self-contained mockup uses sample data. It demonstrates the setting (initially off), per-turn expansion, retained cards, a live turn, an interrupted turn, a turn without prose, and light/dark themes. Controls change only this mockup; they do not change actual settings or dispatch actions. Card details are sample disclosures, not working platform actions.

## Review resolution

ShipIt reviewer run 9c666920-e3e7-4841-a9f3-5b287ce504cb reviewed the initial draft. Accepted: make browser Find/select-all an open decision; remove persistence work; retain rewind gaps and fixed row-group anchors; keep attachment rows whole; place the PR panel outside the transcript; correct search scope and card timing; simplify search reveal; fix mockup labels/contrast and add a no-prose example. The reviewer saw the initial mockup before its browser checks and aria-controls correction; both were completed.

Not accepted as stated: a user-message boundary plus absent streaming flags is not proof of settlement for steered input; conservative active-row guards remain. Mounted hidden rows do not preserve native browser search/select-all, so that remains a user choice. The focus/selection guard remains for automatic collapse, while explicit collapse uses normal disclosure focus. Keeping all cards is the proposed safe default; no relevance classifier or extra card-scope setting is added.

Validation: desktop dark and mobile light browser checks passed for toggle, reveal, cards and overflow. Typecheck passed. lint:dev found no changed TypeScript files. No production source code changed.
