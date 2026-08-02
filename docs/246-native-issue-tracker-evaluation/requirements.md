# Native issue tracking for ShipIt

1. ShipIt must investigate a lightweight issue tracker that can be used directly from ShipIt instead of requiring Linear for issue storage.
2. The investigation must consider existing open-source issue or task trackers that ShipIt could run and manage as part of a ShipIt deployment.
3. The investigation must include a first-party implementation owned by ShipIt as one of the evaluated options.
4. The options must be documented and compared so that ShipIt can make an informed implementation decision.
5. The proposed approaches must address the motivating problem that terminal Linear issues continue to count toward Linear's free issue limit until Linear archives them.
6. The selected tracker must keep its issues private and separate from ShipIt's public repository. It may be hosted by GitHub in a dedicated private repository; ShipIt does not have to operate the storage service itself.

## Open questions

None for the evaluation phase. Selecting and implementing an option will require a separate product decision.

## Resolved questions

- 2026-08-02 — The user expanded the investigation from a first-party tracker to include open-source solutions that ShipIt could run itself.
- 2026-08-02 — The requested deliverable is documentation of the candidates, the first-party alternative, and their comparison; implementation is not part of this evaluation phase.
- 2026-08-02 — The user clarified that “private tracker” means issues must not live in ShipIt's public repository. A dedicated private GitHub repository is acceptable, so hosted GitHub Issues remains a viable option rather than merely a disqualified baseline.
