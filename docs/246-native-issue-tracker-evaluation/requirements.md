# ShipIt issue tracker — product requirements

1. ShipIt must inventory the capabilities of its current tracker wrapper and the user must classify each capability as required, optional, or not needed before an implementation is selected. The selected tracker must support every required capability; optional gaps must be explicit rather than silently treated as parity failures.
2. The tracker must support private issue data kept outside ShipIt's public source repository. It may use a dedicated private GitHub repository or private storage operated with ShipIt.
3. The tracker must be free to use and must not require a paid subscription.

## Open questions

- Classify each current-wrapper capability below as **Required**, **Optional**, or **Not needed**. Every row remains **TBD — user decision** until explicitly classified.

| ID | Current ShipIt capability | Classification |
|---|---|---|
| C1 | List issues, including open/done scope | TBD — user decision |
| C2 | Search, filter, sort, group, and nested rendering in the Issues UI | TBD — user decision |
| C3 | View issue title, description, status, priority, labels, assignee, parent, and timestamps | TBD — user decision |
| C4 | Create an issue from the UI or `shipit issue` | TBD — user decision |
| C5 | Edit issue title and description | TBD — user decision |
| C6 | Discover available statuses and change status, including Started, Done, Canceled, and reopen | TBD — user decision |
| C7 | Read and write priority | TBD — user decision |
| C8 | List, create, apply, replace, and remove labels | TBD — user decision |
| C9 | Read, assign, and clear assignees | TBD — user decision |
| C10 | List, add, and undo/delete comments | TBD — user decision |
| C11 | Create, view, and change parent/sub-issue relationships | TBD — user decision |
| C12 | Start a ShipIt session from an issue with issue context injected | TBD — user decision |
| C13 | Agent access through tracker-neutral `shipit issue` commands | TBD — user decision |
| C14 | Brokered agent-write provenance cards and Undo | TBD — user decision |
| C15 | Automatically mark an issue Started when work begins from an issue | TBD — user decision |
| C16 | PR `Refs` progress comments without closing the issue | TBD — user decision |
| C17 | PR `Closes`/`Fixes`/`Resolves` completion and resolved-by comments | TBD — user decision |
| C18 | Preserve stable issue pointers in docs, chat, sessions, and PR lifecycle parsing | TBD — user decision |

## Resolved questions

- 2026-08-02 — The user clarified that “private tracker” means issues must not live in ShipIt's public repository. A dedicated private GitHub repository is acceptable, so hosted GitHub Issues remains a viable option rather than merely a disqualified baseline.
- 2026-08-02 — The user separated product requirements from research requirements and specified three product constraints: no less functionality than ShipIt's wrapper, private issue data, and free use without a subscription.
- 2026-08-02 — The user relaxed blanket wrapper parity: each current capability must be reviewed and classified as required or optional (with “not needed” available for explicit removal). GitHub feasibility is evaluated only against the capabilities ultimately marked required.
