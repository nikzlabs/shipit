# Checklist — device viewport control

- [x] `requirements.md` written from the issue's words; open decisions resolved and recorded as benchmark assumptions
- [x] Custom size retained across preset/fill switches; cleared only by session reset (req 4)
- [x] Escape closes the selector menu from inside the Custom inputs (req 4)
- [x] `resolveDeviceViewport` extracted from `useDeviceFrame` and unit-tested (reqs 3–6)
- [x] Store tests updated to pin the retention semantics
- [x] Live browser verification of presets, freeform, orientation and breakpoint flipping
- [x] `npm run typecheck` and `npm run lint:dev` clean; touched suites plus `test:dev` green