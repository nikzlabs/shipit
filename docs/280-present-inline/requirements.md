---
issue: planning#470
title: Inline present — artifacts rendered in the conversation
description: A flag on the present tool that renders a small artifact as a card in the chat transcript instead of only in the Present tab.
---

# Inline present

The `present` tool shows a self-contained artifact in ShipIt's Present tab. That
is the right surface for something the user studies — a full mockup, a large
diagram, a rendered doc. It is the wrong surface for something small the user
should just *see* while reading the reply: a thumbnail, a small chart, a
two-line SVG, a short rendered table. Those need the conversation itself.

1. The agent can show a self-contained artifact **rendered in place inside the
   chat transcript**, so the user sees it while reading the reply and does not
   have to open the Present tab.
2. Inline is a **variant of the existing `present` API selected by a flag on
   that same tool** — not a second tool.
3. An inline artifact is referenced **by file path**, exactly as a Present-tab
   artifact is. The tool takes no literal-content parameter.
4. The inline surface is **not limited to images or HTML**. Every artifact kind
   `present` already supports — HTML, SVG, markdown, images, plain text —
   renders inline.
5. Inline artifacts are for **small** things. The card is bounded so it cannot
   take over the conversation, and an artifact larger than the bound stays
   readable inside its bound rather than being rejected.
6. An inline artifact **also appears in the Present tab carousel**, and the card
   offers a way to open it there.
7. Inline HTML **runs its own JavaScript and receives the Agent Interface SDK**,
   so an inline artifact can collect input and send a composed message back to
   the agent that owns the session.
8. An inline card **survives a session switch, a full page reload, and a
   container restart**, like every other transcript card.
9. **Re-presenting the same file inline updates the card that is already in the
   transcript** instead of adding a second one — the identity of an artifact is
   its file path, at every layer.

## Open questions

None.

## Resolved questions

- 2026-08-22 — How should the inline variant be exposed to the agent: a separate
  tool, or a flag on `present`? → **A flag on `present`.** (req 2)
- 2026-08-22 — Where should the inline content come from: a file path, literal
  content in the tool call, or both? → **File path only.** (req 3)
- 2026-08-22 — Should inline HTML be interactive? → **Scripts, plus the Agent
  Interface SDK.** (req 7)
- 2026-08-22 — How should an inline card relate to the Present tab: inline only,
  or also in the carousel? → **Inline and in the carousel.** (req 6)
