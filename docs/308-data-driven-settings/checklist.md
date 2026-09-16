# Data-driven settings UI — checklist

Design is settled: [requirements.md](requirements.md), [plan.md](plan.md),
[inventory.md](inventory.md). Each slice below is one pull request.

- [x] Requirements written, with all three open questions answered and receipted
- [x] Per-setting inventory: all 77 declarations, 15 problems and dependencies
- [x] Design: two declaration fields, a shared scalar reader and writer, a control table by value kind
- [x] Subtraction review, and the design cut down to what it found
- [ ] Slice 1 — the spine, delivered on Advanced: value record, `useSetting` / `saveSetting`, the control table, `section`, the whole Advanced tab
- [ ] Slice 2 — Instructions, Git, Network: the textarea convention and conflict state (P14), the git identity control, `own-route` writes (P2)
- [ ] Slice 3 — Voice: the remaining browser values, the TTS choices component (P7), the webhook pair (P9), the webhook always visible (P13)
- [ ] Slice 4 — Integrations: the two credential rows (P10), `autoCreatePr` always visible (P13)
- [ ] Slice 5 — panels: register the nine components and bind them to their declarations
- [ ] Slice 6 — Project Settings: the second dialog, its repo-scoped write, the colour picker, the secrets panel (req 10)
- [ ] Slice 7 — cleanup: delete the coverage walk and `data-setting` (req 12, P15)
