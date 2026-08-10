---
issue: planning#348
title: Composer toolbar layout — design
description: How the composer row collapses below 700px of its own width, and where the settings go.
---

# 260 — Composer toolbar layout: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## The shape

One threshold, one branch, measured on the composer's own width rather than the window's (req 2, req 3):

| Composer width | Row |
|---|---|
| **≥ 700 px** | Untouched — the row exactly as it shipped before this feature |
| **< 700 px** | `+ · [⚙ model-name ⌄] · ◕` ⟶ spacer ⟶ `mic · stop · send` |

Below the threshold the permission mode, harness, model and reasoning controls leave the row and live behind one control, which also carries the model name (req 4, req 6). The context ring stays beside it (req 7). The attach button stays too (req 16).

## Why the width comes from the container, not the viewport

The previous attempt at this bug was keyed on `useIsMobile()` — a `matchMedia("(max-width: 767px)")` on the **window**. The chat panel is a draggable split, so the composer's width is the panel's, and a 1920 px window with the panel dragged to 520 px reports "desktop" and renders the widest possible row into the narrowest space. That is the reported bug, and no window-keyed rule can see it (req 2).

`useNarrowContainer` (`hooks/useNarrowContainer.ts`, from docs/206) already does exactly this: a `ResizeObserver` on a ref'd element against a px breakpoint. It is reused rather than re-implemented, and its two existing properties are load-bearing here:

- it returns `false` until measured, so the first paint is the **wide** row and the narrow row appears only once a real width is known — no flash of a collapsed layout on a wide screen;
- it returns `false` where `ResizeObserver` is unavailable, which is jsdom. Every existing composer test therefore keeps seeing the wide row and needs no change; the narrow row is tested by stubbing the observer, the way `useTabLabelCollapse.test.ts` already does.

A CSS `@container` query was the other candidate and was rejected: the two rows are different DOM, not the same DOM restyled, so a CSS-only rule means rendering both and hiding one — two mounted dropdown trees, duplicated `data-testid`s, and two copies of the picker state. The JS branch renders one row.

## How the row cannot overflow any more

The guarantee in req 1 is structural rather than arithmetic — nothing depends on the controls happening to add up:

```
<div class="flex items-center px-2 pb-2">        ← row, no gap of its own
  <div class="flex flex-1 min-w-0 gap-1 overflow-hidden">   ← the elastic group
    +   [⚙ model-name ⌄]   ◕
  </div>
  mic   stop   send                              ← shrink-0, outside the group
</div>
```

Mic, Stop and Send are **outside** the clipping group and are `shrink-0`, so no amount of content on the left can move them (req 1). Inside the group the anchor is `flex-[0_1_auto] min-w-0` and the ring is `shrink-0`, which fixes the order in which things give way (req 8): the model name truncates to an ellipsis first because it is the only elastic thing, and only when it has nothing left does the ring start to be cut by the group's edge — which sits flush against the mic's hit area, so the ring appears clipped by the mic's square.

Measured: the ring is only ever cut below **≈280 px** of composer width, narrower than any phone. The clip is a backstop, not a routine state.

**The exact bound, because "structural" overclaims if left unqualified.** What this construction guarantees is that *no amount of content on the left can displace the action buttons* — the left group collapses to zero before they are touched, and that part needs no arithmetic. It does not by itself prove the actions fit: below roughly **190 px** of composer width the action cluster alone (three 44 px targets plus their 4 px gaps, inside 16 px of row padding, 2 px of border and 32 px of composer padding) is wider than the composer, and nothing further can give. That floor is well under req 13's 360 px and under any real chat panel, and it is a property of the buttons' own sizes rather than of anything the row does — but it is the honest edge of the claim, so a future editor adding a fourth pinned action knows where the budget actually ends.

Measured room for the model name, and what fits (req 4, req 5, req 13):

| Composer width | 320 | 360 | 390 | 430 | 520 |
|---|---|---|---|---|---|
| Room for the name | 10 | 50 | 80 | 120 | 210 |
| `Opus 5` (43 px) | … | ✓ | ✓ | ✓ | ✓ |
| `GPT-5 Codex` (77 px) | … | … | ✓ | ✓ | ✓ |

## Touch targets are not on this axis

Hit-area size keeps following the viewport media query (`useIsMobile`), not the container (req 14). The two questions are different: how *dense* the layout is depends on how much room there is, but whether a target needs to be thumb-sized depends on whether it is being touched. So a 600 px chat panel on a desktop gets the narrow row with compact buttons, and a 600 px tablet gets the narrow row with large ones.

## The settings menu

A **drill-down**, not Radix submenus: one `DropdownMenuContent` whose body swaps between a root list and one panel at a time, with a back header. Radix's `Sub` primitives anchor a second floating menu to the side on hover, which is wrong for touch and would need two new primitives exported; drill-down needs neither and matches how the panels were mocked and approved.

Root — four rows, each showing its current value, so nothing needs opening twice to be read:

```
⚙  Mode        Auto      ›
🤖 Harness     Claude Code 🔒
✨ Model       Opus 5    ›
🧠 Reasoning   High      ›
```

The Mode row's **icon is the current mode's own icon** and its value is tinted when the mode is not `auto` (req 12). The composer's anchor never changes with the mode — that was decided explicitly, and its accepted consequence (guarded and plan are invisible until the menu opens) is recorded in the requirements' receipts.

Two levels rather than one flat list because the menu has to survive catalogue growth (req 11): reasoning already has six levels per harness, models will grow, and the model panel is expected to gain a search field. A flat menu grows without bound; the drill-down's root stays four rows whatever happens inside a panel.

The harness row does not drill down when the session has pinned it — it renders the lock and the reason inline, as the standalone selector does today.

## Reuse, not duplication

`ModelSelector` carries ~80 lines of subtle precedence logic (optimistic pick → session model → live model → saved seed → first row) plus the group resolution that keeps the trigger label and the checkmark from contradicting each other. The menu's model panel needs exactly that, and a second copy would drift.

So the state is extracted into hooks used by both:

- `useModelPickerState()` — rows, groups, the displayed name, the selected `(service, mode, model)` triple, the ambiguity pill, and the select handler.
- `useHarnessPickerState()` — installed harnesses, the displayed one, whether the session pinned it, and its name.

`ModelSelector` and `HarnessSelector` become thin renderers over those hooks and keep their existing behaviour for the wide row.

`compactTrigger` on `HarnessSelector` and `ReasoningSelector` becomes dead — below 700 px neither renders in the row at all — so it is removed along with the `isMobile` threading it needed, rather than left as a second, parallel narrowing mechanism (req 9 is met by the menu, which gives these controls their full names back).

## What the narrow row gives up

- The context ring shows without its token-count and cost figures (req 15); both remain in the menu's Context row, which opens the usage modal as before.
- The permission mode is not stated in the row. See the requirements' receipt for the trade and how to reverse it.

Everything else keeps its accessible name (req 9): the anchor's `aria-label` names the model and the fact that it opens settings, and each menu row is a normal, labelled item.

## Key files

- `src/client/components/MessageInput/MessageInput.tsx` — the branch, the clipping group, the pinned action buttons.
- `src/client/components/MessageInput/ComposerSettingsMenu.tsx` — new: the anchor and the drill-down panels.
- `src/client/components/ModelPicker.tsx` — `useModelPickerState` / `useHarnessPickerState` extracted; `compactTrigger` removed.
- `src/client/components/ReasoningSelector.tsx` — `compactTrigger` removed.
- `src/client/components/ContextDial.tsx` — `compact` prop: ring only, no figures.
- `src/client/hooks/useNarrowContainer.ts` — reused unchanged.
