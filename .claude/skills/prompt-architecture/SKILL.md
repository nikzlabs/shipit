---
name: prompt-architecture
description: "How ShipIt stores and composes LLM prompts: prompt text as .md data files loaded at module top level, composition in TypeScript, the byte-stability prompt-cache contract, and how to test prompts (composition and caching, never literal wording). Load when editing agent system instructions, voice cleanup, session naming, or any prompt-composing code."
user-invocable: true
---

# Prompt architecture

LLM prompts — agent system instructions, voice cleanup, session naming — are **content, not logic**. Keep the two separated.

## Prompt *text* is data: it lives in `.md` files

Co-locate the `.md` with the code that composes it. Prose reviews as prose, diffs cleanly, and needs no backtick or `${}` escaping.

Load it with `loadPrompt(import.meta.url, "./x.md")` (`orchestrator/load-prompt.ts`), **at module top level** — once at init, never per call. A missing file then throws at boot rather than mid-turn.

**Not** a bundler `?raw` import: production runs TS via tsx with no bundler, so `fs.readFileSync(new URL(...))` is what actually works.

Examples: `agents/<id>/system-prompt.md`, `voice/cleanup-prompt.md`, `orchestrator/prompts/*.md`.

**Known exception:** `session-namer.ts` still defines its `PROMPT_TEMPLATE` inline in TypeScript and substitutes per call. It predates this convention and is not a model to copy — if you touch it, move the text to an `.md` rather than extending the inline template.

## Prompt *composition* is code

Axis branching and fragment selection stay in TypeScript. In `agent-instructions.ts`, `renderInstructions` fills `{{TOKEN}}` holes in `prompts/skeleton.md` via `fillPromptTokens`, which **throws on an unfilled token** — that's the guard ensuring no literal `{{FOO}}` ever reaches the model.

There are **two axes**: `agentId` (Parallel-sessions wording) and the session **mode**, which has **three** values — `std`, `ops` (docs/128), and `sandbox` (docs/211). `isOps` and `isSandbox` are mutually exclusive, and ops wins if both are passed. Every `(agentId, mode)` pair is precomputed, so don't write code or tests that assume a single `isOps` boolean.

## The prompt-cache contract is load-bearing

Every `(agentId, mode)` variant renders **once at module load** into `PRECOMPUTED_INSTRUCTIONS`, a module-level `ReadonlyMap` (typed as read-only; not runtime-frozen). The per-turn path is a pure lookup, which keeps the CLI string byte-stable so the Anthropic prompt cache stays warm.

**Never move composition or the `.md` reads onto a per-call path.** Doing so silently destroys cache hits on every turn.

## Testing prompts

**Test composition and caching, never literal wording.** A pure `prompts/*.md` copy-edit should require **no** test changes.

*Do* assert:
- Fragment selection per `agentId` / `isOps`
- Variant distinctness, and non-ops byte-identity
- Byte-identity of the precomputed constants across repeated lookups. **Note the limit**: the rendered instructions are *strings*, and JS strings are primitives, so `toBe`/`Object.is` passes for two independently assembled equal strings. Such a test pins the *value*, not the absence of per-call reassembly — don't claim it proves caching. To actually pin that, assert on the map identity or spy on the compose path.
- Call-site threading
- The cheap load guard: every variant non-empty, no leftover `{{TOKEN}}`
- Presence/absence keyed off a **structural anchor** — a `##` header, a command token — not a sentence

*Don't* assert specific prose phrases. They churn on copy-edits, and were deliberately removed from `agent-instructions.test.ts` for that reason.

Provider and integration tests reference the **imported constant** (`toContain(CLEANUP_INSTRUCTIONS)`), never a pasted copy.

See `voice/providers/*-cleanup.test.ts` and `integration_tests/system-prompt.test.ts`.
