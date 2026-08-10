---
issue: planning#348
title: Composer toolbar layout
description: What the composer's control row must do when it is narrower than its contents.
---

# 260 — Composer toolbar layout: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

## Why this exists

The composer's control row has more controls than it has width, and the row neither wraps nor scrolls. The overflow is invisible until it reaches the right-hand end, where it pushes **Send off the screen** — the one control the user cannot do without.

Measured against the real component (all figures are CSS px of *content* against the space the row has):

| State | 320 | 360 | 390 | 430 |
|---|---|---|---|---|
| Idle | +114.4 | +74.4 | +44.4 | +4.4 |
| Turn running | +144.4 | +104.4 | +74.4 | +34.4 |

Three facts shaped everything below, and each contradicted an assumption that had been made before measuring:

1. **It is not a running-turn problem.** The row overflows when idle too, at every phone width, including 430 px. A running turn adds the Stop button and 30 px, which makes it worse rather than causing it.

2. **It is not a mobile problem.** On desktop the chat panel is a draggable split, so the composer's width is the *panel* width, not the window's. Nothing is compacted there and the context dial reveals two extra text labels, so several controls are *wider* on desktop. The row needs a panel of **595–808 px** before it stops clipping; drag the split toward the preview and Send is cut off exactly as on a phone. A window-width media query cannot see this, which is why the previous fix did not.

3. **The worst simultaneously-satisfiable case is 590.4 px of controls into 270 px of space** — guarded mode (a 123.5 px label), a model id offered under both a subscription and an API key (a 160.9 px label), voice on, a turn running. Nothing there is exotic. A fix validated only against the common case still breaks for that user.

The row already contained three controls that had been collapsed to icons to buy width, and it still overflowed. That is the evidence for a structural change rather than a fourth shrink: **too many controls for the width is the problem, not the width of any one of them.**

## Requirements

1. Send is always fully visible and tappable, at every composer width, in every state, in **both** layouts. So are Stop and the mic. No control may push them out of view. **Anything that does not fit is clipped instead** — clipping is always preferred to displacing these three.

2. This holds for any composer width, not any window width. A wide window with a narrow chat panel must behave like a narrow screen.

3. Below a composer width of **700 px**, the row uses a compact layout. At 700 px and above it renders as it does today. "As today" describes what the user sees whenever the row fits; it does not license the wide row to break requirement 1, which outranks it.

4. In the compact layout, the model currently in use is readable in the row itself, without opening anything. When there is not enough room for the whole name it is truncated with an ellipsis.

5. "Opus 5" is fully readable at a composer width of 360 px and above.

6. The model name is not its own separate picker. It is shown inside the settings control, between that control's icon and its chevron.

7. The context usage ring stays in the row, immediately to the right of the settings control.

8. Whatever does not fit — the context ring in the compact layout, a control's label in the wide one — is cut off at the left edge of the mic button rather than being allowed to displace anything. The mic, Stop and Send keep their positions regardless, in both layouts.

9. Every control removed from the compact row remains reachable behind the settings control, and none of them loses its name to a screen reader or a long press.

10. The settings menu is two-level: a short list of settings with their current values, each opening its own panel.

11. The settings menu stays usable as the number of models grows. It must not become a single long scrolling list as more models and more reasoning levels are offered, and the model panel must be able to become a searchable list later without the rest of the menu changing shape.

12. Inside the settings menu, the permission-mode row carries the icon of the mode currently in force.

13. Composer widths below 360 px are explicitly not a target. Behaviour there only has to be non-destructive — requirement 1 still holds, and the model name may be truncated to nothing.

14. How large the mic, Stop and Send targets are follows the **viewport**, not the composer: at a viewport under 768 px they are large enough to hit with a thumb at every composer width, and at or above it they stay compact even when the chat panel is dragged narrow. The viewport is a proxy for "is this being touched", and an imperfect one — see the issue linked in the receipt below.

15. In the compact layout the context ring shows as a ring alone. Its token count and running cost are not shown beside it, and remain one tap away in the ring's own popover.

16. The attach button stays in the compact row. Attaching a file is an action taken while composing, not a setting, and it does not move behind the settings control.

17. A non-default permission mode is named by the mode alone — "Guarded", "Plan" — not "Guarded mode". This is the label in the composer row; the menu that offers the choice may still spell it out.

18. The composer's model control shows the model's name only. It does not append the service or billing mode ("Subscription", "API key") to that name, even when the same model id is offered under more than one.

## Requirement provenance

Requirements 1–8 and 10–13 were stated by the human in chat, most of them in direct response to a rendered mock-up.

Requirements 14–16 began as agent proposals. Each was put to the human as an open question with its alternative and a recommendation, and each was answered on 2026-08-10 — see the first three receipts below. They are requirements because they were chosen, not because they were suggested.

Requirement 9 is the one item inherited from an existing repo convention rather than newly asked for: `ReasoningSelector`'s compact mode already keeps the full label in `title` and `aria-label`, and the harness selector followed it. It is written down here because the compact layout hides considerably more than either of those did.

No requirement is an unreviewed agent inference.

## Open questions

None. Implementation is unblocked.

## Resolved questions

- 2026-08-10 — Should the permission mode be an icon in the wide row, given that "Guarded mode" at 123.5 px is the widest single contributor to the row's worst case? Chosen: **keep the icon and the word, but the word alone** — "Guarded", not "Guarded mode". The human's first reaction was "an icon at most"; shown the mock, the call was the shorter label rather than dropping the label. Requirement 17 follows. The menu that offers the choice still spells out "Guarded mode", where there is room and the extra word reads as a description rather than a badge.

- 2026-08-10 — Should the model control keep the service pill that disambiguates a model id offered under two `(service, billing)` pairs? Chosen: **no, drop it.** Requirement 18 follows. Stated consequence, accepted: with the same id under both a subscription and an API key, the composer no longer says which one this session bills — the honest answer moves one tap away, into the model panel, where the grouping and the checkmark still show it. That reverses a docs/252 decision which put the pill there precisely because "a bare id cannot say who is billing you"; the pill was disclosure-on-demand, and it turned out to cost 80.5 px in the state that was already overflowing.

- 2026-08-10 — The cross-backend review found requirements 1 and 3 incompatible between 700 px and ~808 px: the un-compacted row can need up to 808 px, and requirement 3 hands back to it at 700 px, so guarded mode and an ambiguous model id could still push Send off the edge in that band. Chosen: **clipping is the universal rule** — "if something is overflown, it is clipped, never affecting mic/send/cancel". The wide row gets the same pinned action cluster as the compact one, so a label is cut off instead of Send disappearing. Requirements 1, 3 and 8 were rewritten to say this: requirement 3's "as today" now describes what the user sees *whenever the row fits*, and is explicitly outranked by requirement 1. The rejected alternatives were raising the threshold to ~810 px (contradicts the 700 px the human chose, and puts more desktops on the compact row) and narrowing requirement 1 to "below 700 px" (leaves the original bug alive in a band nobody would think to test).

- 2026-08-10 — Requirement 14 said target size follows "the device"; the code reads `(max-width: 767px)`, a viewport-width proxy rather than an input-modality test, so a landscape tablet at 768 px gets compact targets. Chosen: **say the viewport**, because that is what ships and the wording was the inaccurate half. Requirement 14 now names the viewport and admits it is a proxy. Switching to a `pointer: coarse` test is filed separately as planning#350 — it would change hit-area behaviour for the wide row too, which is beyond this feature.


- 2026-08-10 — Should touch-target size follow the composer's width, like everything else, or the input device? Chosen: **the input device**. Layout density follows the composer width (requirement 3), but hit-area size keeps following the screen, because whether a target needs to be thumb-sized is a question about fingers and not about panel width. Requirement 14 follows. Visible consequence, accepted: a 600 px chat panel on a desktop keeps compact buttons while a 600 px tablet keeps large ones — the two look different at the same composer width, deliberately.

- 2026-08-10 — *(corrected 2026-08-10, after the cross-backend review)* Requirement 15 originally said the ring's figures "remain available inside the settings menu". That clause was written while the ring itself was going to live inside the menu; once the human moved the ring back into the row it became wrong, and the review caught the code not matching it. The figures are in the **ring's own popover** — the ring is right there in the row, so its popover is the same single tap the menu would have been. The requirement now says so. No code changed.

- 2026-08-10 — May the context ring lose its token-count and cost labels on a narrow desktop panel? Chosen: **yes, ring alone below 700 px.** Those labels show today whenever the *window* is 768 px or wider, so a desktop user with the panel at 520 px loses them — but that is already what every phone sees, and the figures stay one tap away in the ring's own popover. Requirement 15 follows. The alternative considered and rejected was a third size band keeping the labels between roughly 480 and 700 px: it removes nothing from anyone, at the cost of a third state to build and test.

- 2026-08-10 — Does the attach button stay in the compact row, or move behind the settings control? Chosen: **stays in the row**, because attaching a file is an action taken while composing rather than a setting. Requirement 16 follows. The 28 px it costs would otherwise have gone to the model name — enough to make "GPT-5 Codex" fit at 360 px — so this is a deliberate trade of name width for keeping attach one tap away.

- 2026-08-10 — Which of five candidate layouts should be built: moving Stop out of the row, collapsing the model label to an icon, moving all settings behind one control, wrapping to two rows, or a horizontally scrolling strip? Chosen: **moving all settings behind one control**, applied whenever the composer is under 700 px wide. The measured argument is that it is the only candidate whose headroom does not change with state — it fits at 320 px with 42 px to spare and survives the 590 px worst case, because the controls that grow are exactly the ones it removes from the row. The two cheap candidates do not fix the bug: Stop leaving the row saves nothing at all when idle, and collapsing the model label saves 16–34 px against a 145 px deficit. Requirements 3 and 9 follow.

- 2026-08-10 — Should the fix be conditional on a mobile media query, as the previous one was? Chosen: **no — on the composer's own width**, after the human supplied a desktop screenshot showing Send clipped in a narrow chat panel on a wide window. Requirement 2 follows, and it is the reason requirement 3 names a composer width rather than a screen size.

- 2026-08-10 — Where does the model name go once the settings move behind one control? Chosen: **inside the settings control, between its icon and its chevron, with no separate icon of its own** — not as a second control beside it. The human's reason was that it should not become another picker. It also turned out to be the cheaper of the two: a separate slot spends its own padding, an icon and an extra gap before it earns a single character, so folding it in gives the name 30 px more room at every width, which is what makes requirement 5 achievable. Requirements 4 and 6 follow.

- 2026-08-10 — Flat settings menu, where every choice is one tap, or two-level? Chosen: **two-level**. The human's reason was that a flat list will not fit: there are already more than three reasoning levels and there will be more than three models, so it becomes a long scrolling menu — and the model picker is expected to become a search field once many models are supported. Requirements 10 and 11 follow, and requirement 11 records the growth constraint rather than the menu shape alone, so a future editor knows which property must be preserved.

- 2026-08-10 — Should the context ring stay in the row or move into the settings menu? Chosen: **stay in the row, to the right of the settings control**, with the human's condition that the three right-hand buttons must never be pushed out and that the ring itself should be cut off at the mic button's edge if it does not fit. Requirements 7 and 8 follow. Measured consequence: the ring costs the model name 36 px, and because the name is the only elastic item it absorbs all the pressure first — the ring is only cut below about 280 px, narrower than any phone in circulation.

- 2026-08-10 — What happens at 320 px, where the name has room for about two characters? Chosen: **do not design around it** — the human said explicitly that so narrow a width does not matter much. Requirement 13 records it as out of scope rather than as a solved case, so a future editor does not read the truncation there as an oversight.

- 2026-08-10 — Should a non-default permission mode be visible in the composer row, given that guarded and plan change what the agent may do? Chosen: **no — the mode's own icon appears on the settings menu's Mode row, and the control in the composer never changes.** The agent had proposed swapping or tinting the composer control's icon; the human clarified that the icon swap was meant for the menu. Requirement 12 follows. The known consequence, accepted deliberately: guarded and plan are invisible until the menu is opened, where today the wide row states them in words. It is reversible later without touching anything else — tinting the control or swapping its icon are each about a one-line change. Putting the mode *word* in the control is not an option: it measures 58 px, which erases the model name entirely at 360 px.
