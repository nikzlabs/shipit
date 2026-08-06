# LemonCrow runtime evaluation checklist

## Evaluation

- [x] Establish what LemonCrow is, what it installs, and where its state lives, from its own source and docs.
- [x] Identify the ShipIt mechanisms it would touch, verified against this repo's code.
- [x] Document the integration options with effort and risk.
- [x] Record a falsifiable gate for the recommended next step.
- [x] Flag the license ambiguity and project maturity.

## Blocked on a product decision

- [ ] Answer the open questions in [`requirements.md`](./requirements.md) (motivating goal; whether a third-party owner of the agent surface is acceptable).
- [ ] Resolve the license question (README says Apache-2.0, GitHub metadata says NOASSERTION, CLA + planned closed `lemoncrow.pro` engine).
- [ ] Run the token-reduction spike against the gate in [`plan.md`](./plan.md), then accept or reject.
