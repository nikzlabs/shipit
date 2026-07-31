# 241 — Spec discipline: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

1. A feature can have a requirements document like this one. The human writes it, or prompts the agent to write it — and the human must be able to fully understand it. Plain language, no formal notation. It says what the feature must do, not how it is built.

2. The requirements document is separate from the design document, so a human can review it on its own and design work can't quietly change it.

3. Requirements come only from the human, or from assumptions the agent proposed and the human approved. The agent never silently decides an unspecified detail and buries it in the code.

4. When the agent hits something the requirements don't cover, it writes the open question into the requirements document and asks — with a few concrete options and a recommendation, batched rather than one interruption at a time.

5. While a feature has open questions, the agent does not implement it. ShipIt enforces this itself; it does not rely on the agent choosing to follow the rule. Only a human's answer unblocks the feature. The agent removes a question only when writing in that answer, and every edit to this document is visible in the pull request — reviewing that history is how a wrongly removed question gets caught.

6. After implementation, it must be possible to check that what was built matches the requirements, done by a reviewer that is not the session that built it.

7. This works the same for projects developed inside ShipIt as for ShipIt itself.

8. All of this is optional, per project. A project turns it on explicitly; a project that doesn't stays exactly as it is today.

9. A session knows which feature it is working on. When the session is started from an issue, the feature is inferred from that issue; the human can set or change it in chat at any time. A feature can also be invented during a session — prompted directly in chat rather than started from an issue — in which case the agent creates the feature's documents and works on it from then on.

10. When a project turns this on, open questions block from the start — there is no softer report-only mode. If open questions merely produced warnings, the implementer would invent answers to them, and the invented answers would be suboptimal. Only the feature being worked on can block its own work, so unrelated features never get in the way.

## Resolved questions

- 2026-07-31 — Since the agent maintains this document itself, is reviewing the change history enough to catch a question removed without a human answer, or does v1 need a stronger mechanism? Chosen: it is enough for v1 — every edit is visible in the pull request; a stronger mechanism can be added later if this proves a problem in practice. Requirement 5 was reworded to match.
