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

1. Send is always fully visible and tappable, at every composer width, in every state. So are Stop and the mic. No control may push them out of view.

2. This holds for any composer width, not any window width. A wide window with a narrow chat panel must behave like a narrow screen.

3. Below a composer width of **700 px**, the row uses a compact layout. At 700 px and above it renders exactly as it does today, with no change of any kind.

4. In the compact layout, the model currently in use is readable in the row itself, without opening anything. When there is not enough room for the whole name it is truncated with an ellipsis.

5. "Opus 5" is fully readable at a composer width of 360 px and above.

6. The model name is not its own separate picker. It is shown inside the settings control, between that control's icon and its chevron.

7. The context usage ring stays in the row, immediately to the right of the settings control.

8. When the ring does not fit, it is cut off at the left edge of the mic button rather than being allowed to displace anything. The mic, Stop and Send keep their positions regardless.

9. Every control removed from the compact row remains reachable behind the settings control, and none of them loses its name to a screen reader or a long press.

10. The settings menu is two-level: a short list of settings with their current values, each opening its own panel.

11. The settings menu stays usable as the number of models grows. It must not become a single long scrolling list as more models and more reasoning levels are offered, and the model panel must be able to become a searchable list later without the rest of the menu changing shape.

12. Inside the settings menu, the permission-mode row carries the icon of the mode currently in force.

13. Composer widths below 360 px are explicitly not a target. Behaviour there only has to be non-destructive — requirement 1 still holds, and the model name may be truncated to nothing.

14. How large the mic, Stop and Send targets are follows the device, not the composer. On a phone or a tablet they stay large enough to hit with a thumb at every composer width; on a desktop they stay compact even when the chat panel is narrow.

15. In the compact layout the context ring shows as a ring alone. Its token count and running cost are not shown beside it, and remain one tap away in the ring's own popover.

16. The attach button stays in the compact row. Attaching a file is an action taken while composing, not a setting, and it does not move behind the settings control.

## Requirement provenance

Requirements 1–8 and 10–13 were stated by the human in chat, most of them in direct response to a rendered mock-up.

Requirements 14–16 began as agent proposals. Each was put to the human as an open question with its alternative and a recommendation, and each was answered on 2026-08-10 — see the first three receipts below. They are requirements because they were chosen, not because they were suggested.

Requirement 9 is the one item inherited from an existing repo convention rather than newly asked for: `ReasoningSelector`'s compact mode already keeps the full label in `title` and `aria-label`, and the harness selector followed it. It is written down here because the compact layout hides considerably more than either of those did.

No requirement is an unreviewed agent inference.

## Open questions

Both raised by the cross-backend review of the implementation (2026-08-10), and both are conflicts between requirements rather than gaps in them — so neither can be settled by the agent.

- **Requirements 1 and 3 are incompatible between 700 px and ~808 px, and requirement 1 currently loses.** "Why this exists" records that the un-compacted row needs a panel of 595–808 px depending on state; requirement 3 hands back to that row at exactly 700 px. So in the guarded-mode and ambiguous-model states a composer of 700–808 px still pushes Send off the edge — the original bug, in a narrower band. This band also got slightly worse: with the icon-only `compactTrigger` variants removed, a viewport under 768 px now renders full harness and reasoning labels where it used to render icons, which is reachable on a tablet in portrait. Three ways out. **(a)** Raise the threshold to ~810 px, so the wide row is only used where it demonstrably fits — one number, contradicts the 700 you chose, and puts more desktops on the compact row. **(b)** Keep 700 px and give the wide row the same pinned action cluster, so its *labels* clip instead of Send disappearing — preserves requirement 1 absolutely and is invisible whenever the row fits, but it does modify the wide row, which requirement 3 promises is untouched. **(c)** Accept it and narrow requirement 1 to "below 700 px". *Recommendation: (b) — requirement 1 is the whole point of the feature, and the change is invisible in every state that fits today.*

- **Requirement 14 says the target size follows "the device"; the code follows the viewport width.** `useIsMobile()` is `(max-width: 767px)`, a window-width proxy rather than an input-modality test, so a landscape tablet at 768 px gets compact targets and a narrow desktop window gets thumb-sized ones. This is pre-existing behaviour that the feature inherited rather than introduced. **(a)** Reword requirement 14 to say the viewport, as the proxy it is — honest, no code change. **(b)** Switch to a `pointer: coarse` media query — actually implements what requirement 14 says, but changes hit-area behaviour for the wide row too, beyond this feature's scope. *Recommendation: (a) now, (b) as its own change if you want it.*

## Resolved questions

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
