---
issue: planning#470
title: Inline present — implementation
description: How present({ inline: true }) renders an artifact as a persisted chat card while keeping it in the Present carousel.
---

# Inline present — implementation

Implements [requirements.md](./requirements.md).

`present({ inline: true })` renders an artifact as a card in the chat transcript
(req 1) *and* keeps it in the Present-tab carousel (req 6). It is a flag on the
existing tool (req 2), takes the same `file` path (req 3), and supports every
kind `present` already does (req 4).

## The one design decision everything else follows from

**The card carries metadata, never bytes.** That is not a size optimisation — it
is what makes three separate requirements fall out for free:

- **req 9 (one card per artifact).** `presentId` is content-addressed by the
  file path at every layer. The card holds that id, the carousel entry holds
  that id, and both read the same bytes from the same file on demand. So a
  re-present does not need to *patch* the card — it changes what the card was
  already going to show. The screenshot loop iterates and the card follows.
- **req 8 (survives everything).** The card is a persisted `messages` row like
  any other transcript card; the bytes come back off disk whenever it renders.
  A card written weeks ago shows the file as it is today.
- **Graceful decay.** An artifact whose source file is gone degrades to a
  placeholder instead of an empty frame, reusing the Present tab's behaviour.

The alternative — snapshotting bytes into the card row — was rejected: it would
have made the card and the carousel disagree the moment the agent iterated, and
would have needed its own size cap, its own eviction, and a "which one is real"
answer the present flow has deliberately never had.

## Flow

```
present({ file, inline: true })            mcp-tools/present.ts
  → POST /agent-ops/present/submit         session-worker.ts
      registry.put({ …, inline })          present-registry.ts   (sticky)
      SSE present_content { …, inline }
  → runner SSE handler                     container-session-runner.ts
      presentStore.record({ …, inline })   → { inlineCardIsNew }
      emitMessage present_content          → the carousel, every time
      emitChatCard present_inline_card     → the transcript, ONCE
  → client
      handlePresentContent                 present-store (artifact + bytes)
      handlePresentInlineCard              chat message with `presentInline`
      <PresentInlineCard>                  renders from the store entry
```

### Emitted once, and why that lives in the database

The emit gate is `PresentStore.record()`'s return value: `inlineCardIsNew` is
true exactly on the transition from not-inline to inline, computed inside the
same transaction that flips the column. Three cheaper-looking places were wrong:

- **A set on the runner** dies with the container. A restart plus one more
  re-present would emit a second card for the same artifact.
- **The worker's registry** dies the same way, and is per-container.
- **A scan of chat history** would work but asks the question backwards; the
  fact "this artifact has a card" belongs to the artifact.

`inline` is also **sticky** (`MAX()` on upsert, mirrored in the worker registry):
the iteration loop calls `present({ file })` with no flag, and the card is
already in the scrollback, so it can never be demoted.

Emitting from the runner's SSE handler — rather than relaying to an
orchestrator route the way `propose_actions` does — is what makes the gate a
single writer. A second HTTP hop would race the SSE record, and both paths would
have to agree about who owns the column.

## Sizing and the SDK

The frame is sandboxed onto an opaque origin, so the parent cannot measure it.
`RenderedFrame` gained an opt-in `reportHeight` that injects a small script
posting the document's own height; the card clamps it to [64, 420] px. Small
artifacts shrink to fit, large ones scroll inside the cap (req 5) — nothing is
rejected for size.

**What it measures is the body's box, not `documentElement.scrollHeight`**, and
that distinction was found by looking at real pixels rather than by any test.
`scrollHeight` is `max(content, viewport)`, and the viewport here *is* the frame
the embedder already sized — so a one-line artifact in the 220px default frame
reported 220 back, and no artifact could ever shrink. The body's border box plus
its margins is the content height, independent of the frame it sits in. Verified
in Chromium across four artifacts: a one-liner clamps to the 64px floor, an
8-row page sits at its natural 270px, a 60-row page clamps to the 420px ceiling
and scrolls, and a 320×90 SVG lands at 106px. The same reasoning is why the SVG
host drops its `height:100vh` when reporting.

This is deliberately **not** part of the Agent Interface SDK script: that one is
injected into every proxied service preview too, where a permanent
`ResizeObserver` on the user's own app is a cost paid by pages that never need
it.

The SDK itself *is* live for inline HTML (req 7), gated on an
`IntersectionObserver`: an artifact scrolled far up the transcript is not a
surface the user is looking at, so its `sendMessage` is refused and its
`visibility` subscribers are told false. Provenance stays `surface: "present"` —
it is the same tool and the same artifact, seen from the other surface.

## Key files

| File | Change |
|---|---|
| `session/mcp-tools/present.ts` | `inline` parameter + guidance on when to use it |
| `session/session-worker.ts` | accepts `inline`, carries it into the registry and the SSE event |
| `session/present-registry.ts` | `PresentMeta.inline`, sticky on `put` |
| `shared/types/domain-types/chat.ts` | `PresentInlineCard` |
| `shared/types/ws-server-messages/cards.ts` | `WsPresentInlineCard` |
| `shared/types/ws-server-messages/present.ts` | `inline` on the content/state messages |
| `shared/database.ts` | `messages.present_inline`, `presentations.inline` |
| `orchestrator/present-store.ts` | persists `inline`, returns `inlineCardIsNew` |
| `orchestrator/container-session-runner.ts` | emits the card off the SSE stream |
| `orchestrator/chat-history.ts` | `presentInline` column wiring |
| `orchestrator/app-lifecycle.ts`, `bootstrap-managers.ts` | threads `chatHistoryManager` to the runner |
| `client/components/PresentInlineCard.tsx` | the card |
| `client/components/FileContentView/RenderedFrame.tsx` | `reportHeight` |
| `client/hooks/message-handlers/present-inline-card.ts` | live append, idempotent by `presentId` |
| `client/components/visual-elements.ts` | `presentInline` in `CARD_MESSAGE_FIELDS` |
| `server/shipit-docs/present.md` | agent-facing guide |

## Tests

- `orchestrator/present-store.test.ts` — the emit gate: true once, false on every
  re-present, sticky across a restart, per-artifact.
- `orchestrator/integration_tests/present-flow.test.ts` — the full path through a
  real worker: no card for an ordinary present, one card plus a carousel entry
  for an inline one, one card across three re-presents, promotion of an
  already-presented artifact, and no duplicate after a container restart.
- `client/components/PresentInlineCard.test.tsx` — lazy fetch, re-render on
  re-present, per-kind rendering, missing-artifact placeholder, open-in-tab.
- `client/components/FileContentView/RenderedFrame.test.tsx` — height reporting is
  off by default, measures the body box, and drops the viewport-height SVG host.
- The existing `chat-history.test.ts` / `visual-elements.test.ts` guards prove
  the card is not emit-only; adding it to `CARD_MESSAGE_FIELDS` is what turns
  them red until the column and round-trip exist.
