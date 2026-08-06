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

## Prompt *composition* is code

Axis branching and fragment selection stay in TypeScript. In `agent-instructions.ts`, `renderInstructions(agentId, isOps)` fills `{{TOKEN}}` holes in `prompts/skeleton.md` via `fillPromptTokens`, which **throws on an unfilled token** — that's the guard ensuring no literal `{{FOO}}` ever reaches the model.

## The prompt-cache contract is load-bearing

Every `(agentId, isOps)` variant renders **once at module load** into `PRECOMPUTED_INSTRUCTIONS`. The per-turn path is a pure lookup of a frozen constant, which keeps the CLI string byte-stable so the Anthropic prompt cache stays warm.

**Never move composition or the `.md` reads onto a per-call path.** Doing so silently destroys cache hits on every turn.

## Testing prompts

**Test composition and caching, never literal wording.** A pure `prompts/*.md` copy-edit should require **no** test changes.

*Do* assert:
- Fragment selection per `agentId` / `isOps`
- Variant distinctness, and non-ops byte-identity
- Reference-equality of the precomputed constants (cache stability)
- Call-site threading
- The cheap load guard: every variant non-empty, no leftover `{{TOKEN}}`
- Presence/absence keyed off a **structural anchor** — a `##` header, a command token — not a sentence

*Don't* assert specific prose phrases. They churn on copy-edits, and were deliberately removed from `agent-instructions.test.ts` for that reason.

Provider and integration tests reference the **imported constant** (`toContain(CLEANUP_INSTRUCTIONS)`), never a pasted copy.

See `voice/providers/*-cleanup.test.ts` and `integration_tests/system-prompt.test.ts`.
