---
issue: planning#430
title: Harness event-conversion verification recipe
description: Requirements for the recipe that proves a harness version's tool events convert into AgentEvents and are recognized by the transcript UI.
---

# Requirements — harness event-conversion verification

The ask, verbatim: "we need a recipe for how to verify the correct
integration of edits, to-do writes, and so on, that they are recognized by
ShipIt correctly. So there is some conversion layer, and we need to make
sure that it works. This would also be applicable to testing new versions of
harnesses. For example, recently we had an issue with Claude Code that
renamed some of the event schema fields, and it made the to-do list changes
not work correctly in ShipIt."

The precedent to design against: planning#337 — Claude CLI 2.1.220 replaced
`TodoWrite` with the `Task*` tools, and the name-keyed transcript panel
degraded silently to the generic fallback for weeks. The recipe's core test
is: would following it have caught that break before users did, and does it
catch the same class for any harness?

## Requirements

1. A committed document gives a repeatable procedure to verify, for a given
   harness AND a given harness version, that the tool events the CLI emits —
   file edits, to-do/task writes, and the rest of the tool surfaces — are
   converted correctly into ShipIt's `AgentEvent` stream.
2. The same procedure verifies the events are *recognized* downstream:
   the transcript UI renders each surface with its dedicated treatment
   (edit diffs, the task panel, activity labels), not the generic
   unknown-tool fallback, and the rendering survives persistence and
   reload.
3. The procedure covers the "new version of an existing harness" case —
   a CLI version bump is verifiable without redoing a full integration —
   not only the "new harness" case.
4. The procedure catches the planning#337 failure class: an upstream
   rename, replacement, or schema-field change that today degrades
   silently to a fallback rendering instead of failing anywhere.
5. The recipe extends the harness-integration recipe (docs/266): it is
   referenced from docs/266's empirical-verification phase and follows its
   shape (compact checklist plus expanded steps with file pointers).
6. The recipe is harness-agnostic: it applies to every integrated backend
   (Claude Code, Codex, OpenCode) and to future ones, not to one CLI.

## Requirement provenance

Requirements 1–4 restate the ask and its named precedent. Requirements 5–6
come from the commissioning brief for this work (extend docs/266; the
recipe question is "for any harness"). Decisions the brief explicitly
delegated — whether this is a new docs folder, and whether the mechanism is
an executable probe, captured-fixture conformance tests, or both — are
design decisions recorded in `plan.md`, not requirements.

## Open questions

(none currently)

## Resolved questions

(none yet)
