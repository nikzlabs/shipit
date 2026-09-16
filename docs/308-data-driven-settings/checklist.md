# Data-driven settings UI — checklist

Design is settled: [requirements.md](requirements.md), [plan.md](plan.md),
[inventory.md](inventory.md). Each slice below is one pull request.

- [x] Requirements written, with all three open questions answered and receipted
- [x] Per-setting inventory: all 77 declarations, 15 problems and dependencies
- [x] Design: four declaration fields, one reader, one writer, a component registry
- [ ] Slice 1 — the spine: declaration fields, registry, `useSetting` / `saveSetting`, the Advanced toggles and the memory budget
- [ ] Slice 2 — browser values: generic `localStorage` read and write, all 14
- [ ] Slice 3 — sections and order: generate Advanced, Instructions, Git, Network, including non-setting components (P12)
- [ ] Slice 4 — Voice: dynamic enum sources (P7), credential rows (P10), the webhook pair (P9), the webhook always visible (P13)
- [ ] Slice 5 — panels: register the nine components, narrow their props
- [ ] Slice 6 — Project Settings: the second dialog and its repo-scoped write (req 10)
- [ ] Slice 7 — cleanup: delete the coverage walk and `data-setting` (req 12), drop the named selectors, move the ~72 call sites (P1)
