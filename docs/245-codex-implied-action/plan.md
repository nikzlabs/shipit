---
title: Codex implied implementation intent
description: Teach Codex to act on clear, safe continuations without turning information-only questions into edits.
---

# Codex implied implementation intent

## Requirements

This feature is under requirements discipline. [requirements.md](./requirements.md) is the source of truth, and it has no open questions.

## Root cause

`buildAgentSystemInstructions` composes a large shared ShipIt prompt for both backends. The shared prompt says to be action-oriented, but it does not resolve the specific tension between a grammatically information-seeking question and an active implementation task. The only existing backend-specific prompt fragments concern parallel sessions.

That omission matters for Codex because its baseline autonomy policy distinguishes answer/explain requests from change requests and warns against inferring authorization. With no contextual tie-breaker, a confirmation-shaped continuation such as “is this needed?” can be classified literally as information-only even when the active conversation clearly calls for the edit. Claude already produces the intended behavior without additional guidance.

## Design

Add a short Codex-only `implied-action.md` fragment to the existing static prompt composition. It tells Codex to use active-task context, answer and act in the same turn for clear safe/reversible/in-scope continuations, and retain the read-only boundary for genuine questions and the authorization boundary for ambiguous, destructive, externally consequential, or out-of-scope work.

The fragment is selected during the existing module-load precomputation, so prompt-cache stability and the pure per-turn lookup remain unchanged. Claude and the no-agent Settings baseline receive an empty substitution, leaving their rendered instructions unchanged. No runtime intent classifier or new subsystem is introduced.

## Key files

- `src/server/orchestrator/agents/codex/implied-action.md` — Codex-specific behavioral tie-breaker.
- `src/server/orchestrator/agent-instructions.ts` — static variant composition.
- `src/server/orchestrator/agent-instructions.test.ts` — Codex inclusion, behavioral boundaries, and Claude exclusion.
