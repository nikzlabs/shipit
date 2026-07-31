# 241 — Spec discipline: requirements

These requirements were stated by Nik or proposed by the agent and approved by Nik. The design that implements them is in [`plan.md`](./plan.md).

1. A feature can have a requirements document like this one. The human writes it, or prompts the agent to write it — and the human must be able to fully understand it. Plain language, no formal notation. It says what the feature must do, not how it is built.

2. The requirements document is separate from the design document, so a human can review it on its own and design work can't quietly change it.

3. Requirements come only from the human, or from assumptions the agent proposed and the human approved. The agent never silently decides an unspecified detail and buries it in the code.

4. When the agent hits something the requirements don't cover, it writes the open question into the requirements document and asks — with a few concrete options and a recommendation, batched rather than one interruption at a time.

5. While a feature has open questions, the agent does not implement it. ShipIt enforces this itself; it does not rely on the agent choosing to follow the rule. Only a human's answer unblocks the feature — the agent cannot mark its own questions as answered.

6. After implementation, it must be possible to check that what was built matches the requirements, done by a reviewer that is not the session that built it.

7. This works the same for projects developed inside ShipIt as for ShipIt itself.

## Open questions

- How does a session know which feature it is working on — inferred from the issue it was launched from, told explicitly in chat, or configured? Recommendation: inferred at launch, overridable in chat.
- When a project turns this on, does it start in enforcing mode or report-only mode? Recommendation: enforcing, since only the feature being worked on can block its own work.
- Should the repo-wide health check (all features at once) run automatically anywhere, or only when asked? Recommendation: on demand, plus a CI report that never fails the build.
