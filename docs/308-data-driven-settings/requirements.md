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

1. Adding a setting, or changing one, is one edit in one place. Its row, its
   read, its write, where it is stored and where it appears all follow from the
   declaration. No second file has to be touched for the setting to work, and no
   step can be forgotten, because there is no second step.
2. Standard settings render from the declarations. A setting a standard control
   can show is not hand-written anywhere, so a control for an undeclared setting
   has nowhere to exist.
3. A setting whose editing needs its own logic keeps its own component — and that
   component uses the same declaration and writes through the same path as every
   other setting. Custom means how it **looks**, never where the value **goes**.
4. Every row is always visible. A setting that cannot take effect yet says so in
   place, instead of disappearing. Hiding a row is not a behaviour this feature
   has to keep.
5. The declaration gains a field only because a real setting needs it. Where the
   simpler thing already works, the simpler thing is what ships.
6. Where VS Code has already settled the same question, ShipIt takes its answer
   unless there is a reason to differ, and the reason is written down.
7. Every setting is written down before the change: what it is today, what its
   declaration becomes, and which problems and dependencies it carries.
   `inventory.md` in this folder is that document.
8. The agent's view of settings does not change. One declaration serves the
   dialog and `shipit settings`, and every guarantee `docs/299-agent-settings-access`
   makes — descriptions, refusals, proposal cards — still holds.
9. A value the user has already saved is still read after the change, from the
   same place it is stored in now.

## Open questions

- Does this cover **both** dialogs — Settings and Project Settings — or only the
  main one?
- Once rows are generated, does `settings-coverage.test.tsx` (1617 lines) get
  deleted, or kept?
- May the visible **order and grouping** of rows change as a result, or must each
  tab look the same afterwards as it does now?

## Resolved questions

- 2026-09-16 — *Do rows that are hidden today have to stay hidden?* No. The user:
  the hand-crafted tabs and rows are not a requirement, and showing every row
  is acceptable even when it affects nothing. One row group is conditional today
  (the voice webhook, hidden unless delivery is external or both). → requirement 4.
- 2026-09-16 — *What happens to settings that need real custom logic, like the
  services panel?* They keep a custom component, and that component still uses
  the same definition and writes to the same place. → requirement 3.
- 2026-09-16 — *How much should be taken from VS Code?* The user: copy any design
  decision that makes sense, *"because these folks probably thought about it for
  multiple years and settled on the current design."* → requirement 6.
- 2026-09-16 — *Does this belong in docs/299?* No. The user agreed it is a
  separate thing, and related: docs/299 built the declarations, and this makes
  the dialog use them. → this folder, with requirement 8 holding the relationship.
