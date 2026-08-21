---
title: Headless compaction triggers for OpenCode and Grok Build
description: Establish empirically whether these two harnesses expose an on-demand compaction trigger through the headless path, and make the composer's /compact work where they do.
---

# 276 — Headless compaction triggers (requirements)

Extends [docs/178 — Context Compaction](../178-context-compaction/plan.md) to the
two harnesses added since: OpenCode (docs/268) and Grok Build (docs/274). Both
were shipped declaring `supportsCompaction: false`.

The design is [plan.md](./plan.md).

## Requirements

1. Whether each harness supports an on-demand compaction trigger through its
   **headless** path is established by **testing the CLIs**, not by reading
   their documentation or inspecting their binaries.

2. A trigger counts as supported only when the **outcome** is demonstrated —
   that the context actually compacted. A command that exits successfully
   while doing nothing does not count.

3. Where a harness does support it, the composer's `/compact` works on that
   harness, the same way it already works on Claude and Codex.

4. Where a harness does not support it, the catalogue says what was actually
   tested and at which CLI version. The wording must not claim more than was
   established: "no trigger was found" is not "no trigger exists".

5. The evidence is recorded — commands, versions, measurements, and the
   approaches that failed — so that the next person to ask this question does
   not repeat the work.

## Resolved questions

**2026-08-20 — What label does a compaction get when the CLI misreports its own
trigger?** Requirement 3 says `/compact` works "the same way it already works on
Claude and Codex". Grok stamps `trigger: "auto"` on every compaction including
ones ShipIt requested, so forwarding the field would show every user-triggered
compaction as spontaneous — visibly *not* the same as Claude. Codex, which
reports no trigger at all, already established the answer in docs/178: label by
correlation with what ShipIt asked for. Requirement 3 therefore already decides
this and it is not an open question; recorded here because the reasoning is not
obvious from the requirement's wording alone.

## Open questions

None.
