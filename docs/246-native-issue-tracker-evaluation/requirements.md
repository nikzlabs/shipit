# ShipIt issue tracker — product requirements

1. The issue tracker must provide functionality no less than ShipIt's current tracker wrapper. At minimum, ShipIt's existing Issues UI, `shipit issue` agent commands, brokered writes and Undo, issue creation and editing, status, priority, labels, assignees, comments, parent/sub-issues, session creation, and `Refs`/`Closes` PR lifecycle must continue to work without losing capability.
2. The tracker must support private issue data kept outside ShipIt's public source repository. It may use a dedicated private GitHub repository or private storage operated with ShipIt.
3. The tracker must be free to use and must not require a paid subscription.

## Open questions

None.

## Resolved questions

- 2026-08-02 — The user clarified that “private tracker” means issues must not live in ShipIt's public repository. A dedicated private GitHub repository is acceptable, so hosted GitHub Issues remains a viable option rather than merely a disqualified baseline.
- 2026-08-02 — The user separated product requirements from research requirements and specified three product constraints: no less functionality than ShipIt's wrapper, private issue data, and free use without a subscription.
