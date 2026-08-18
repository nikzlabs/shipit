---
issue: planning#433
title: Grok Build harness
description: Grok Build (xAI's `grok` CLI) as the fourth harness — Claude-shaped spawn-per-turn adapter, per the docs/266 recipe.
---

# Grok Build harness

Implements [requirements.md](./requirements.md), by following
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md)
(req 7). This doc will hold only what is Grok-specific: the Phase 0 findings,
the catalogue row decisions, the non-npm install design (req 3), and the
adapter design. The step-by-step is [checklist.md](./checklist.md), copied
from the recipe template.

## Status

Phase 0 live verification pending — this session started under a network
pause; findings land here once egress is enabled and the CLI is installed
and driven in-container. Desk-research baseline:
[candidates.md §Grok Build](../266-harness-integration-recipe/candidates.md).
