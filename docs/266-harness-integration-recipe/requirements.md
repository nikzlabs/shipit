---
issue: planning#392
title: Harness integration recipe
description: Requirements for the documented recipe that makes each new coding-harness backend cheaper to integrate than the last.
---

# Requirements — harness integration recipe

ShipIt will add more coding harnesses soon: Cursor CLI, Grok, and OpenCode.
Before the first of those lands, the integration path itself must be
investigated and documented so each subsequent harness is easier to do.

## Requirements

1. A committed document describes the full recipe for integrating a new
   coding-harness CLI backend into ShipIt, derived from how the two existing
   backends (Claude Code CLI, Codex CLI) are integrated.
2. The recipe enumerates every surface an integration must touch — with
   pointers into the code — so an implementer can work through it as a
   checklist rather than rediscovering touchpoints.
3. The recipe is harness-agnostic: it applies to any future CLI backend, not
   only the three named next.
4. The recipe states what must be true of a candidate CLI before integration
   starts (the capability checklist a candidate is assessed against), so an
   unsuitable candidate is identified before code is written.
5. The three named candidates — Cursor CLI, Grok, OpenCode — are assessed
   against that capability checklist, so the first real integration can start
   from facts rather than a fresh investigation.

## Open questions

(none currently)

## Resolved questions

(none yet)
