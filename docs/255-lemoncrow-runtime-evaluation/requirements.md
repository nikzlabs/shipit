# LemonCrow runtime integration — research requirements

Research requirements for evaluating [LemonCrow](https://github.com/lemoncrow-lab/lemoncrow)
as an integration into ShipIt. There is no product requirement yet: this phase
produces a decision, not an implementation.

1. ShipIt must investigate how the LemonCrow runtime could be integrated into a ShipIt session.
2. The investigation must establish what LemonCrow actually does and what it installs, from the project's own source and documentation rather than from its marketing claims.
3. The investigation must identify every ShipIt mechanism the integration would touch or break, verified against ShipIt's code rather than assumed.
4. The investigation must present the possible integration shapes with their effort and risk, so ShipIt can decide whether to proceed.
5. Any recommended next step must be falsifiable — a measurement or spike whose outcome can reject the integration.

## Open questions

- **What is the motivating goal — cost, speed, or context headroom?** LemonCrow's pitch is all three at once ("25% faster, 30% cheaper"), and the three point at different integration shapes and different measurements. The evaluation currently assumes cost-per-turn on ShipIt's own subscription-authenticated agents; confirm or redirect.
- **Is a third-party layer between ShipIt and the agent CLI acceptable at all?** ShipIt currently owns the whole agent surface (tool allowlist, hooks, MCP bridges, transcript rendering). Accepting LemonCrow means accepting a second owner of that surface, or restricting it to the parts ShipIt does not own.

## Resolved questions

- 2026-08-06 — The requested deliverable is an investigation of integration options, not an implementation.
