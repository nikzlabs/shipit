---
issue: planning#580
title: Data-driven settings UI
description: The settings dialogs render from the declarations, so adding or changing a setting is one edit in one place instead of three.
---

# Data-driven settings UI

The user's words: *"I want it to be as much data-driven as possible. Of course,
there are some custom settings like services that require a lot of custom logic.
Maybe they could be separate. They would still write to the same. They would
still use the same definition, but would have a custom UI components. Whereas
others, I want it to be completely data-driven, so it's harder to mess up when
changing or adding settings."*

## Why this exists

`docs/299-agent-settings-access` gave ShipIt one declaration per setting, because
the agent needed a single description and a single policy for every setting it
can read. That structure did not exist before — *"it was never needed to have
such a structured way to have settings. Before, we had two ways to read and write
them."*

The dialog did not follow. A setting's **words** come from its declaration today,
but its **row**, its **read** and its **write** are still hand-written per
setting. Adding one means three edits in three files, and the tabs grew that way,
one control at a time. The hand-written half is where a setting gets bound to the
wrong field, saved to the wrong store, or shipped with no declaration at all —
and docs/299 answered that risk with a 1617-line test that walks the rendered DOM
looking for controls nobody declared.

This feature removes the hand-written half instead of watching it. The tabs as
they stand are not a requirement; they are how the code grew.

## Requirements

1. Adding a setting a standard control can show, or changing one, is one edit in
   one place. Its row, its read, its write, where it is stored and where it
   appears all follow from the declaration. No second file has to be touched for
   it to work, and no step can be forgotten, because there is no second step.
   A setting that needs its own component still has one declaration and one
   destination; only what it looks like is written by hand.
2. Standard settings render from the declarations. A setting a standard control
   can show is not hand-written anywhere, so a control for an undeclared setting
   has nowhere to exist.
3. A setting whose editing needs its own logic keeps its own component — and that
   component uses the same declaration and writes to the same place as every
   other setting, with the same save behaviour. Custom means how it **looks**,
   never where the value **goes**.
4. Every row is always visible. A setting that cannot take effect yet is not
   hidden. Hiding a row is not a behaviour this feature has to keep.
5. The declaration gains a field only because a real setting needs it. Where the
   simpler thing already works, the simpler thing is what ships.
6. Where VS Code has already settled the same question, ShipIt takes its answer
   when it makes sense here.
7. Every setting is written down before the change: what it is today, what its
   declaration becomes, and which problems and dependencies it carries.
   `inventory.md` in this folder is that document. This one is a deliverable of
   the change rather than behaviour the product has afterwards.
8. The agent's view of settings does not change. One declaration serves the
   dialog and `shipit settings`, and every guarantee `docs/299-agent-settings-access`
   makes — descriptions, refusals, proposal cards — still holds.
9. A value the user has already saved is still read after the change, from the
   same place it is stored in now.
10. Both dialogs are covered — Settings and Project Settings. Neither keeps a
    second way of building a control.
11. Where a row appears comes from its declaration. Where that changes the order
    a tab has today, the new order is what ships.
12. No test walks the rendered dialog to prove that its controls are declared.
    Once the rows are generated, that walk is deleted rather than narrowed.

## Open questions

None. All three were answered on 2026-09-16; the receipts are below.

## Resolved questions

- 2026-09-16 — *Do rows that are hidden today have to stay hidden?* No. The user:
  the hand-crafted tabs and rows are not a requirement, and showing every row
  is acceptable even when it affects nothing. Two are conditional today: the
  voice webhook pair, hidden unless delivery is external or both, and
  `integrations.autoCreatePr`, hidden while GitHub is disconnected.
  → requirement 4.
- 2026-09-16 — *What happens to settings that need real custom logic, like the
  services panel?* They keep a custom component, and that component still uses
  the same definition and writes to the same place. → requirement 3.
- 2026-09-16 — *How much should be taken from VS Code?* The user: copy any design
  decision that makes sense, *"because these folks probably thought about it for
  multiple years and settled on the current design."* → requirement 6.
- 2026-09-16 — *Does this cover both dialogs, or only the main one?* Both. The
  user chose it over leaving Project Settings hand-written, which would have kept
  a second way of building controls — the thing this feature removes. Project
  Settings adds 5 declarations over 3 tabs, 2 of which become ordinary rows
  because that dialog is already open for one repository. → requirement 10.
- 2026-09-16 — *Once rows are generated, is `settings-coverage.test.tsx` (1617
  lines) deleted, narrowed to the panels, or kept?* Deleted. A generated row
  cannot exist without a declaration, so the class the walk detects becomes
  impossible. The compile-time stored-shape maps stay: they run in the opposite
  direction and cost nothing. → requirement 12, and `inventory.md` P15.
- 2026-09-16 — *May the visible order and grouping of rows change?* Yes. Order
  comes from each declaration, and rows will move. The alternative — choosing
  order numbers that reproduce today's layout exactly — would have encoded how
  the tabs grew rather than how they should read. → requirement 11.
- 2026-09-16 — *Does this belong in docs/299?* No. The user agreed it is a
  separate thing, and related: docs/299 built the declarations, and this makes
  the dialog use them. → this folder, with requirement 8 holding the relationship.
