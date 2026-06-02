---
description: Render a dedicated "Sent comments" card when the user submits doc/diff comments, and funnel every WS "send to agent" callsite through one shared client helper.
---

# Doc-comment submission feedback + unified send path

## Problem

Two bugs in the same flow:

1. **No receipt.** When the user added comments on a doc (or diff lines) and
   hit *Send comments*, the chat surface showed nothing. The agent silently
   started working; the user couldn't tell whether their comments had even
   been transmitted.

2. **Bypassed code path.** `handleFileSendComments` in `App.tsx` dispatched
   `send_message` directly without setting `session.setIsLoading(true)` or
   `session.setActivity(...)`, so the loading spinner and status label stayed
   idle even though the agent was working in the background. The other four
   client callsites (main chat input, follow-up buttons, `/review`, "Ask
   agent to review") each inlined the same three setters by hand, but with
   slight variations — and one had forgotten them entirely.

The second bug violated the project rule that all "send to the agent" paths
must go through the same code path so they share optimistic state setup.

## Design

### One shared client entrypoint

Introduce `sendUserMessage` (`src/client/utils/send-user-message.ts`) as the
single client-side funnel for "user is sending something to the agent over
the WebSocket." It takes:

- `bubble` — the optimistic `ChatMessage` to append (caller composes it so
  each surface can carry its own metadata: files, uploads, images, the new
  `userReview` payload, …)
- `activity` — the label shown next to the spinner
- `dispatch` — a closure that puts the WS frame on the wire (so callers
  choose between `send(frame)` and `setPendingWsMessage(frame)`)

The helper just sets `messages`, `isLoading`, `activity` and runs `dispatch()`.
Small on purpose: the win is that *every* callsite goes through one funnel,
not that the funnel does a lot.

All five WS callsites now route through it:

| Callsite | Activity | Bubble extras |
|---|---|---|
| `handleSend` (main chat input) | `Thinking...` | files, uploads, images |
| `handleSendFollowUp` (follow-up buttons) | `Thinking...` | — |
| `onAnswerQuestion` (AskUserQuestion answers) | `Thinking...` | — |
| `/review` command | `Reviewing...` | — |
| `handleAskAgentReview` ("Ask agent to review" button) | `Reviewing...` | — |
| `handleFileSendComments` (doc/diff *Send comments*) | `Working on comments...` | `userReview` |

The HTTP counterpart (`dispatchAgentMessage` for *Create PR*, *Fix CI*,
*Send compose error*) stays separate — it owns its own error-rollback
semantics and is dispatched over HTTP, not WS.

### Dedicated "Sent comments" card

`ChatMessage` gains an optional `userReview` field carrying `filePaths[]` +
`commentCount`. When a user message has this field, `MessageList` renders a
`UserReviewCard` instead of the normal text bubble. The card is styled like
`SubagentCall`:

- left-border accent in the info color
- header: icon + "Sent comments on `<filePath>` · N comments"
- a single collapsed-by-default disclosure showing the full prompt body
  (the same prompt that was shipped to the agent)

The prompt text remains on `msg.text` so chat-history reload, search and
copy-paste all keep working — the card is purely a render-time alternative.

### Surfacing structured payload from the comment surfaces

To populate the card without re-parsing the prompt:

- `useFileReviewStore.sendDraft` now returns `{ prompt, filePath, commentCount }`
  (it already had the `FileReview` object from the server response — it just
  wasn't surfacing the metadata).
- `onSendComments` on `FilePreviewModal` and `DiffPanel` takes a
  `SendCommentsPayload` (`{ prompt, filePaths[], commentCount }`) instead
  of a bare `prompt` string. `DiffPanel` derives `filePaths` from the
  per-file grouping it already builds for the prompt body.

## Key files

- `src/client/utils/send-user-message.ts` — new shared helper
- `src/client/components/UserReviewCard.tsx` — the new card component
- `src/client/components/MessageList.tsx` — `userReview` field + branch
- `src/client/components/FilePreviewModal.tsx` — exports
  `SendCommentsPayload`; `handleSend` now builds it from `sendDraft`'s
  structured result
- `src/client/components/DiffPanel.tsx` — `onSendComments` signature change;
  derives `filePaths` from the per-file comment grouping
- `src/client/stores/file-review-store.ts` — `sendDraft` returns
  `SentDraftPayload` instead of a bare prompt string
- `src/client/App.tsx` — every WS "send to agent" callsite now funnels
  through `sendUserMessage`

## Tests

- `MessageList.test.tsx` — verifies the `UserReviewCard` renders with the
  right header / count and the prompt body is collapsed by default but
  expandable.
- `file-review-store.test.ts` — `sendDraft` returns the new payload shape.

`npm run lint`, `npm run typecheck`, and `npm run test:dev` all pass.
