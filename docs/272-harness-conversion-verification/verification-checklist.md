---
title: Harness conversion verification checklist (template)
description: Copy into the integration folder or the version-bump PR; every line is expanded, with file pointers, in plan.md.
---

# Harness conversion verification — checklist template

One line per step; the expansion of every line is in
[plan.md](../272-harness-conversion-verification/plan.md) (a path that
still resolves after the copy). For a **version bump**, run the "bump
subset" lines; for a **new harness**, run everything. Deliberately not
named `checklist.md` — that name tracks docs/272's own branch work.

**Header (fill in first)**
- Harness: ____  CLI version: ____  Date: ____  Model: ____

**Bump subset**
- [ ] Tour turn captured with the candidate CLI (Step 1), provenance
      recorded
- [ ] Inventory diff vs the previous recorded inventory (Step 2): tool
      names, event types/subtypes, input keys, result shapes
- [ ] No delta → recorded as such on the bump PR; stop here
- [ ] Delta → conformance captures + provenance comments updated in
      `session/agents/<id>/adapter.test.ts` (Step 3)
- [ ] Delta → registry updates for every affected surface ship in the
      bump PR (appendix table walked end to end)
- [ ] Delta → Layer C run for the affected surfaces (Step 4), incl.
      page-reload rehydration

**Full recipe (new harness, or major schema change)**
- [ ] Step 1 capture per auth mode actually supported
- [ ] Step 2 inventory: every event type has an adapter case (no
      `default: return null` hits); every tool name in `<X>_TOOL_NAMES` +
      tool map + its surface's registry; every matrix surface has an
      observed driver; input keys and result shapes verified
- [ ] Step 3 conformance test with byte-shaped replay + provenance
      header, incl. lossy/terminal paths
- [ ] Step 4 dogfood tour per harness, serial turns; matrix asserted on
      persisted history; UI snapshot; reload + re-snapshot
- [ ] Interactive surfaces (AskUserQuestion, ExitPlanMode) verified via
      fixture replay + one manual UI turn
- [ ] Negative control run once against the checker (fabricated tool
      name flagged)
- [ ] Step 5 record: one file per run —
      `docs/272-harness-conversion-verification/runs/YYYY-MM-DD-HHMM-<harness>-<cli-version>.md`
      with `run:` frontmatter metadata, inventories + per-surface
      artifacts observed; linked from the bump PR
