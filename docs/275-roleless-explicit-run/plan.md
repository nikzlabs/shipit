---
issue: planning#441
title: Role-less explicit run completeness — plan
description: Per-harness completeness for the explicit spawn target — effort required exactly where the harness declares levels.
---

# 275 — Role-less explicit run completeness: plan

Implements [requirements.md](./requirements.md). Amends docs/261's explicit-path design
and lifts docs/274's "one deliberate limitation".

## The change in one sentence

The explicit `SpawnTarget`'s completeness rule stops being "the five flags" and becomes
"every parameter the named harness has" (req 2): the four identity flags always, and
`--effort` exactly where the harness declares reasoning levels — mirroring the rule the
role path has shipped since docs/264 (effort optional = Default; a level named on a
no-levels harness refused by name).

## Design

- **`SpawnTarget`'s `explicit` kind** (`shared/types/agent-types.ts`): `reasoningEffort`
  becomes optional. Present iff the harness declares levels; absent means "pass no flag",
  exactly as the role-at-Default path already reads it — `ResolvedSpawnTarget` and
  `AgentSpawnOptions` have treated absence that way all along, so nothing downstream
  changes.
- **`parseSpawnTarget`** (`services/sub-agent-target.ts`) becomes harness-aware for the
  one thing shape alone cannot decide: whether `--effort` is part of a complete call. It
  consults the static catalogue (`getHarness`) for the named harness's reasoning options.
  The four identity flags are always required; `--effort` joins the missing list only
  where the harness declares levels (req 2/4). When the harness itself is missing or
  unknown, the conservative five-flag message stands — the caller must name a real
  harness before effort's existence is decidable. A blank `--effort=` is refused as an
  empty value (`readNamed`), never read as absence (req 3's "never silently dropped").
- **`resolveSpawnTarget`'s explicit branch** stays the validator of record and gains the
  role path's exact refusal pair: a level on a no-levels harness → "declares no reasoning
  levels … omit `--effort`"; a missing or unrecognized level on a level-having harness →
  refusal naming the valid levels. An unknown harness id is refused as `Unknown agent`
  here rather than falling into the API-style message.
- **The shim** (`agent-shim/shipit-agent.ts`) keeps its local completeness message for
  the four flags it can judge without the catalogue, and stops requiring `--effort`
  locally — effort's requiredness is a catalogue fact only the server knows, and the shim
  "buys a message for what it can know and does not pretend to know the rest". Its
  refusal text says effort is also required where the harness declares levels, pointing
  at `shipit agent params`.
- **`shipit agent params`** prints, for a no-levels harness, that a complete role-less
  call omits `--effort` (req 6).
- **Both commands** get this through the one shared parser (req 5) — the session-spawn
  route already calls `parseSpawnTarget` with `parentBase: true`. A consequence worth
  stating: a four-flag call naming a no-levels harness now parses as a **complete
  explicit target** on `session create` too, where it used to fall into the inherit path
  and could have an inherited effort completed onto a harness that cannot take one.
- **Prompt-side rule untouched** (req 7): the system-prompt "complete target" wording
  ("a command naming every parameter **it runs on**") is parameter-count-agnostic and
  stays byte-identical; `shipit-docs/agent.md` is updated to describe the per-harness
  shape.

## Key files

- `src/server/shared/types/agent-types.ts` — `explicit.reasoningEffort?`
- `src/server/orchestrator/services/sub-agent-target.ts` — parser + resolver
- `src/server/session/agent-shim/shipit-agent.ts` — local check + params print
- `src/server/orchestrator/services/sub-agent-target.test.ts` — the grok acceptance case
  (a fully-specified four-flag grok target validates end to end) and the refusal matrix
- `src/server/shipit-docs/agent.md` — the in-container contract
- `docs/261-configurable-reviewer/plan.md`, `docs/274-grok-build-harness/plan.md` —
  amended rationale / lifted limitation
