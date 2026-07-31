# 241 — Spec discipline: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

1. A feature can have a requirements document like this one. The human writes it, or prompts the agent to write it — and the human must be able to fully understand it. Plain language, no formal notation. It says what the feature must do, not how it is built.

2. The requirements document is separate from the design document, so a human can review it on its own and design work can't quietly change it.

3. Requirements come only from the human, or from assumptions the agent proposed and the human approved. The agent never silently decides an unspecified detail and buries it in the code.

4. When the agent hits something the requirements don't cover, it writes the open question into the requirements document and asks — with a few concrete options and a recommendation, batched rather than one interruption at a time.

5. While a feature has open questions, the agent does not implement it. ShipIt enforces this itself; it does not rely on the agent choosing to follow the rule. Only a human's answer unblocks the feature — the agent cannot mark its own questions as answered.

6. After implementation, it must be possible to check that what was built matches the requirements, done by a reviewer that is not the session that built it.

7. This works the same for projects developed inside ShipIt as for ShipIt itself.

8. All of this is optional, per project. A project turns it on explicitly; a project that doesn't stays exactly as it is today.

9. A session knows which feature it is working on. When the session is started from an issue, the feature is inferred from that issue; the human can set or change it in chat at any time. A feature can also be invented during a session — prompted directly in chat rather than started from an issue — in which case the agent creates the feature's documents and works on it from then on.

10. When a project turns this on, open questions block from the start — there is no softer report-only mode. If open questions merely produced warnings, the implementer would invent answers to them, and the invented answers would be suboptimal. Only the feature being worked on can block its own work, so unrelated features never get in the way.

## Open questions

- Requirement 5 says the agent cannot mark its own questions as answered. In the simplified v1, the agent maintains the requirements document itself, so ShipIt still blocks implementation while questions are listed — but a question removed without a human answer would be caught by reviewing the document's change history, not prevented by a mechanism. Is that acceptable for v1, or does requirement 5 need the stronger guarantee from the start? Recommendation: acceptable for v1 — every edit to the document is visible in the pull request, and a stronger mechanism can be added later if this proves a problem in practice.
