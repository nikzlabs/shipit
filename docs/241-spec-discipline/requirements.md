# 241 — Spec discipline: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

This is a way of working, not machinery: the workflow is written in this repository's own agent instructions, and the agent follows it. Nothing here requires ShipIt functionality.

1. A feature can have a requirements document like this one. The human writes it, or prompts the agent to write it — and the human must be able to fully understand it. Plain language, no formal notation. It says what the feature must do, not how it is built.

2. The requirements document is separate from the design document, so a human can review it on its own and design work can't quietly change it.

3. Requirements come only from the human, or from assumptions the agent proposed and the human approved. The agent never silently decides an unspecified detail and buries it in the code.

4. When the agent hits something the requirements don't cover, it writes the open question into the requirements document and asks — with a few concrete options and a recommendation, batched rather than one interruption at a time.

5. While a feature has open questions, the agent does not implement it. Only a human's answer unblocks the feature, and the agent removes a question only when writing in that answer. The agent follows this because this repository's instructions say so; nothing prevents it mechanically. Every edit to the requirements document is visible in the pull request, and reviewing that history is how a skipped question gets caught.

6. After implementation, it must be possible to check that what was built matches the requirements, done by a reviewer that is not the session that built it.

7. This is a working rule of the ShipIt repository, not a ShipIt product feature. Another project gets the discipline only by writing it into its own agent instructions.

8. All of this is optional, per feature. A feature is put under the discipline explicitly, by giving it a requirements document; every feature and project that doesn't do this stays exactly as it is today.

9. The agent works on one feature at a time and knows which one: the feature the session was started from, or the one the human named in chat. A feature can also be started from a direct prompt in chat rather than an issue, in which case the agent creates the feature's documents and works on it from then on.

10. Open questions block implementation from the moment a feature has them — there is no softer mode where they are merely noted. If open questions only produced warnings, the implementer would invent answers to them, and the invented answers would be suboptimal. Only the feature being worked on is affected, so unrelated features never get in the way.

11. The rules live in this repository's own agent instructions. ShipIt's product code carries nothing about the discipline: no fragment in the system instructions it builds, and no page in the documentation it bakes into session containers. A session working on a different repository sees no trace of it.

## Later versions

- Enforcement by ShipIt itself, so that following the workflow does not depend on the agent choosing to (planning#275). Deliberately deferred: this version is worth using on its own, and using it is how we learn what enforcement actually needs to prevent.

## Resolved questions

- 2026-07-31 — Since the agent maintains this document itself, is reviewing the change history enough to catch a question removed without a human answer, or does the first version need a stronger mechanism? Chosen: it is enough — every edit is visible in the pull request. Requirement 5 was reworded to match.
- 2026-07-31 — Should the first version enforce the workflow in ShipIt, or rely on the agent following instructions? Chosen: instructions only, adding no new ShipIt functionality; enforcement moves to a later version.
- 2026-08-20 — The first version put the rules in the system instructions ShipIt builds for every session and in a page baked into every session container, so every repository got them. Should they stay there? Chosen: no — move them into this repository's own `CLAUDE.md` and feature folder, so other repositories are not affected. Requirement 7 was rewritten and requirement 11 added.
