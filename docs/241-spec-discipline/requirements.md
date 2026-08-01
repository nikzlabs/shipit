# 241 — Spec discipline: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

This first version is a way of working, not new machinery: ShipIt gives the agent the workflow as instructions, and the agent follows it. Nothing here requires new ShipIt functionality beyond those instructions.

1. A feature can have a requirements document like this one. The human writes it, or prompts the agent to write it — and the human must be able to fully understand it. Plain language, no formal notation. It says what the feature must do, not how it is built.

2. The requirements document is separate from the design document, so a human can review it on its own and design work can't quietly change it.

3. Requirements come only from the human, or from assumptions the agent proposed and the human approved. The agent never silently decides an unspecified detail and buries it in the code.

4. When the agent hits something the requirements don't cover, it writes the open question into the requirements document and asks — with a few concrete options and a recommendation, batched rather than one interruption at a time.

5. While a feature has open questions, the agent does not implement it. Only a human's answer unblocks the feature, and the agent removes a question only when writing in that answer. In this version the agent follows this because ShipIt instructs it to; nothing prevents it mechanically. Every edit to the requirements document is visible in the pull request, and reviewing that history is how a skipped question gets caught.

6. After implementation, it must be possible to check that what was built matches the requirements, done by a reviewer that is not the session that built it.

7. This works the same for projects developed inside ShipIt as for ShipIt itself.

8. All of this is optional, per feature. A feature is put under the discipline explicitly, by giving it a requirements document; every feature and project that doesn't do this stays exactly as it is today.

9. The agent works on one feature at a time and knows which one: the feature the session was started from, or the one the human named in chat. A feature can also be started from a direct prompt in chat rather than an issue, in which case the agent creates the feature's documents and works on it from then on.

10. Open questions block implementation from the moment a feature has them — there is no softer mode where they are merely noted. If open questions only produced warnings, the implementer would invent answers to them, and the invented answers would be suboptimal. Only the feature being worked on is affected, so unrelated features never get in the way.

## Later versions

- Enforcement by ShipIt itself, so that following the workflow does not depend on the agent choosing to (SHI-273). Deliberately deferred: this version is worth using on its own, and using it is how we learn what enforcement actually needs to prevent.

## Resolved questions

- 2026-07-31 — Since the agent maintains this document itself, is reviewing the change history enough to catch a question removed without a human answer, or does the first version need a stronger mechanism? Chosen: it is enough — every edit is visible in the pull request. Requirement 5 was reworded to match.
- 2026-07-31 — Should the first version enforce the workflow in ShipIt, or rely on the agent following instructions? Chosen: instructions only, adding no new ShipIt functionality; enforcement moves to a later version.
