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
- [ ] 6b — The Roles and Services panels, and `services.nonTurnModel`
- [ ] 7 — Project Settings
- [ ] 8 — Cleanup: the coverage walk and `data-setting` go
