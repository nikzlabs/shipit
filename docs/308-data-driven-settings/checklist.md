# Data-driven settings UI — checklist

The implementation order lives in [plan.md](plan.md) → *Slices*, one pull request
each, and the work is tracked on planning#580.

## Design

- [x] Requirements written, from what the user asked for
- [x] Per-setting inventory: all 77 declarations, with their store, agent policy and target control
- [x] Design: two declaration fields, a machine-readable route store, a shared scalar reader and writer, a control table by value kind
- [x] Subtraction review, and the design cut down to what it found
- [x] Pull-request review, and its corrections folded in — P17 to P19
- [x] Requirement 12 settled on the corrected facts: the walk goes, and the bounded loss is recorded

## Slices

- [x] 1 — The spine, on Advanced's nine toggles
- [x] 2 — Routes and the rest of Advanced
- [x] 3 — Instructions and Git
- [x] 4 — Voice
- [x] 5 — Integrations
- [x] 6a — The list panels on Integrations, Network and Keyboard
- [x] 6b — The Roles and Services panels, and `services.nonTurnModel`
- [x] 7 — Project Settings
- [x] 8 — Cleanup: the coverage walk and `data-setting` go
- [x] The two runtime defects slice 8 recorded: `saveSetting` answers whether the
      write landed, and the own-route reads are ordered per address
- [x] 9 — The last second edit against requirement 1: the renderer places the
      tab's Save, and the `OWN_ROUTE_READERS` entry and the `ownedBy` prose are
      decided rather than changed
- [x] 10 — The three placements the shipped order got wrong: `order` on the
      declaration for Background work and the Voice-notes section, and
      auto-create-PR onto Advanced → Automation
