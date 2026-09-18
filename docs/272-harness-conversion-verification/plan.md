---
issue: planning#430
title: Harness event-conversion verification recipe
description: How to prove, per harness and per harness version, that CLI tool events convert into AgentEvents and get their dedicated transcript treatment — not the silent generic fallback.
---

# Harness event-conversion verification recipe

Implements [requirements.md](requirements.md). Companion to the harness
integration recipe — [docs/266-harness-integration-recipe/plan.md] Phase 10
sends you here, and the copyable one-page form of this recipe is
[verification-checklist.md](verification-checklist.md).

The precedent this is designed against (req 4): **planning#337**. Claude CLI
2.1.220 replaced `TodoWrite` with the `Task*` tools; the task panel keyed on
the literal string `TodoWrite`, so it silently stopped rendering, each
`TaskCreate` fell through to the generic one-line row, and nothing anywhere
went red — for weeks. Fixed in d409940c. The question this recipe answers:
what procedure catches that class, for any harness, before users do.

## When to run it (req 3)

1. **New harness integration** — the full recipe, as docs/266 Phase 10's
   expansion of "stream-capture conformance test".
2. **Version bump of an existing harness** — a Renovate PR touching
   `docker/agent-cli/package.json`. This is the planning#337 path: the bump
   itself is one line, and today nothing between it and production exercises
   the real CLI. docs/141's Axis-3 "CLI contract test" is the designed-but-
   unbuilt automation of exactly this step (its checklist is all unchecked,
   and Renovate auto-merge is deliberately off until it lands); until then,
   this recipe run **is** the bump verification, recorded on the bump PR.
3. **A silent-degradation report** — the transcript shows generic one-line
   rows or an empty panel where a dedicated card used to be. Run the
   recipe's Layer B/C steps to locate which registry stopped matching.

## What you are verifying — the three layers

The conversion layer is not one layer. A harness event crosses three, and
they fail differently, so each needs its own check.

**Layer A — stream conversion** (`session/agents/<id>/adapter.ts`: CLI raw
stream → the 13-member `AgentEvent` union, `shared/types/agent-types.ts`).
The Claude adapter is a name-agnostic passthrough — `mapEvent`
(`claude/adapter.ts`) contains no tool-name literals; tool_use blocks flow
through verbatim. What CAN break here is the *event vocabulary*: an
unrecognized event `type` or `system.subtype` (Claude) falls into
`mapEvent`'s `default: return null`, and an unrecognized Codex item type
(`commandExecution`, `fileChange`, `collabToolCall`, …) falls out of the
item dispatch (`default: break`) — either way the event **vanishes from
the transcript entirely**. The Codex adapter also synthesizes tool names
from those item types, so there a rename loses the whole call, not its
label. Failure mode:
silent drop.

**Layer B — name recognition.** Raw CLI tool names are persisted verbatim
into chat history, and roughly fifteen literal-name registries across
shared/orchestrator/client decide every dedicated treatment (see the
[registry inventory](#appendix--the-literal-name-registries)). Two facts
make this the dangerous layer:

- **The canonical tool map is not on this path.** `canonicalizeTool`
  (`session/agents/tool-map.ts`) had zero production call sites; it was a
  guard vocabulary exercised only by `tool-map.test.ts` (2026-09-02: the map,
  its per-harness slices and that test were deleted for exactly that
  reason), and that test
  compares two hand-maintained constants (`<X>_TOOL_NAMES` ↔ the map) to
  each other, never to the CLI. Both files can agree and be jointly wrong.
- **Unknown degrades benignly — mostly.** An unrecognized name gets the
  generic row, the raw-text label, the `Using <name>...` activity — a
  transcript that *looks* fine. Two spots lose data instead:
  `inputKeyTreatment` (`shared/transcript-input-policy.ts`) defaults to
  `drop`, so a renamed task/whole-input tool has its inputs stripped off
  the wire with no fetch path back; and `rendersResultContentInline`
  (`shared/transcript-slice-tools.ts:118`) returns `false` for a non-empty
  unknown name, so a renamed `TaskCreate` loses the result body that
  carries the CLI-assigned task id.

**Layer C — end-to-end recognition** (req 2): grouping
(`agent-listeners.ts`, `agent-message-builder.ts`), wire projection
(`transcript-projection.ts`), persistence, and the client renderers
(`message-tools.tsx`, `task-list.ts`, `visual-elements.ts`,
`MessageList/`, `StreamingIndicator.tsx`). Only here does "recognized"
become observable: the diff block, the task panel, the plan card — and only
here do reload/rehydration bugs (the panel-vanishes-after-reload class)
show up.

## The core principle: verify surfaces, not names

Name lists cannot be the oracle — names are exactly what the upstream CLI
changes, and planning#337 happened *with the new names already
half-adopted* (`claude/tool-map.ts` and `StreamingIndicator.tsx` listed the
`Task*` tools; no renderer did). Comparing our lists to each other proves
agreement, not correctness.

What is stable is ShipIt's **surfaces**: "the agent edited a file", "the
agent updated its to-do list", "the agent spawned a subagent". So the
recipe's oracle is the recognition matrix below: for each surface, a real
turn must (a) produce *some* tool call that claims it, and (b) yield that
surface's **dedicated artifact** — the thing only the specialized path
produces and the generic fallback never does. A rename then fails loudly:
either no observed call claims the surface (the driver tool disappeared
from the stream) or the artifact is missing (the new name isn't wired to
the renderer). Both are checkable without knowing the new name in advance.

## The recognition matrix (reqs 1, 2)

| Surface | Dedicated artifact — what "recognized" means | Where it is decided |
|---|---|---|
| File edit / write | Diff block with `diffStats` on the persisted message; Write content green-tinted | `transcript-projection.ts` `DIFF_INPUT_TOOLS`; `message-tools.tsx` `"Edit"`/`"Write"`/`"apply_patch"` branches |
| To-do / task write | Task panel renders: `foldTaskList(messages)` non-null with the expected items and statuses; panel keys (`subject`, `status`, `activeForm`, `taskId`) survive projection; created-task id parsed from the tool **result** | `shared/task-list-tools.ts`; `client/components/task-list.ts` (incl. the `Task #<id>` result-prose regex); `rendersResultContentInline` |
| Read / search / shell | Icon + one-word label (not raw text); specialized result renderer; `command` head-sliced not dropped | `message-tools.tsx` `TOOL_ICONS`, `ToolResult.tsx`; `transcript-input-policy.ts` |
| Subagent spawn | `SubagentCall` card with `subagentEvents` attached — not the compact Skill chip | `SUBAGENT_REPORT_TOOL_NAMES` (`shared/transcript-slice-tools.ts`); `MessageToolUse.tsx` |
| Plan mode | `EnterPlanMode` chip; `ExitPlanMode` → interactive `PlanApproval` whose body survives reload (`findPlanContent` / `isPlanDocumentWrite`) | `agent-listeners.ts` interrupt path; `permission-broker.ts` `HANDLED_INTERRUPT_TOOLS`; `MessageList.tsx` |
| User question | Turn interrupts and the question card renders (not a dead-end permission card, not an auto-resolved turn) | `isWellFormedAskUserQuestion`; `HANDLED_INTERRUPT_TOOLS`; `message-tools.tsx` |
| Live activity | `activityFromTool` yields the specific label ("Editing …", "Updating tasks…"), not `Using <name>...` | `StreamingIndicator.tsx` |
| Grouping | Task-list and standalone tools don't shatter bubbles; tool-only events split at result boundaries as before | `STANDALONE_MERGE` (two copies: `agent-message-builder.ts`, `client/hooks/message-handlers/agent-event.ts`), `visual-elements.ts` |
| MCP tools (present, voice note, browser) | Present chip / voice card / browser labels render | `tool-names.ts` `isPresentTool`; `voice-note-router.ts`; `BROWSER_LABELS` |

The interactive rows (user question, plan approval) cannot be driven
headlessly — they exist to stop the turn. Verify them from the captured
stream + a fixture replay (Layer A/B) and, on a major version bump, one
manual UI turn.

## The procedure

### Step 1 — capture a tool-tour stream (per harness, per version)

Drive one real turn whose prompt exercises every headless-drivable surface,
and keep the raw stream. The tour prompt (adapt paths to the sandbox repo):

> Do exactly the following, in order, then stop. 1) Create a to-do list
> with three items for this job and keep it updated as you go. 2) Read
> package.json. 3) Create a file `probe-note.md` with two lines. 4) Edit
> one line of `probe-note.md`. 5) Run `echo conversion-probe` in the
> shell. 6) Search the repo for the string "conversion-probe". 7) Spawn a
> subagent to count the files in the repo root and report the number.
> Mark all to-dos complete.

How to capture, per harness (all verified conventions from the existing
adapter tests, which state provenance in their headers):

- **Claude**: run the CLI with `--output-format stream-json` in a session
  container (or the dogfood `dev` container) and tee the NDJSON.
- **Codex**: `codex app-server`, drive the JSON-RPC handshake + one turn,
  log both directions.
- **OpenCode**: `opencode run --format json --auto`, tee stdout
  (`opencode/adapter.test.ts`'s capture was made exactly this way).

Record with the capture: CLI name, exact version (the
`docker/agent-cli/package.json` pin), date, model used. A capture without
provenance cannot later tell you whether it is stale.

### Step 2 — inventory diff (Layer A + B, the cheap check)

From the capture, extract three inventories: observed **tool names**,
observed **event types / system subtypes / item types**, and observed
**input keys + result shapes** for the matrix surfaces. Then diff:

1. Every observed event type/subtype has an adapter case — anything that
   would hit `default: return null` is a red flag (Layer A silent drop).
2. Every observed tool name is in `<X>_TOOL_NAMES`
   (`shared/agent-tool-names.ts`) and, where the harness has a normalizer,
   in its `<X>_TRANSCRIPT_TOOL_NAMES` table (or its named exclusion list)
   — and, per surface, is a member of the registry that grants its treatment
   (`TASK_LIST_TOOL_NAMES`, `DIFF_INPUT_TOOLS`,
   `SUBAGENT_REPORT_TOOL_NAMES`, …; see the appendix). Membership in a
   name table alone proves nothing — that was planning#337's half-adoption.
3. Every matrix surface has at least one observed driver. **A surface
   whose old driver disappeared from the stream is the rename tell**: on
   2.1.220 the tour would have shown `TodoWrite` gone and `TaskCreate`
   present, before any UI was opened.
4. Input keys the registries depend on (`subject`, `taskId`, `status`,
   `activeForm`, `file_path`, `questions`, `todos`, `changes`) are still
   spelled the same; result shapes still match what the parsers read
   (e.g. `task-list.ts`'s `Task #<id>` prose regex — a *result-text*
   dependency the tool map can never see).

### Step 3 — lock the capture into conformance tests (Layer A)

The repo convention (follow it, don't invent a parallel one): replayed,
byte-shaped real stream lines inline in `session/agents/<id>/adapter.test.ts`
with a provenance header — `opencode/adapter.test.ts` is the model ("REAL
capture from `opencode run --format json --auto`, CLI 1.18.15, 2026-08-16
— trimmed of noise but byte-shaped as observed, not hand-idealized").
Assert the mapped `AgentEvent` sequence, including the lossy/terminal
paths (synthesized result on missing final event, error → terminate).

On a version bump: rerun the existing conformance tests against your Step-2
inventory; where the new CLI's shapes changed, update the replayed lines
**and the provenance comment** in the same commit. A capture-backed test
whose provenance says a three-versions-old CLI is the staleness signal —
`git log` on the test file is currently the only recapture reminder, which
is why the checklist makes it explicit.

### Step 4 — end-to-end recognition run (Layer C)

Run the tour as a real dogfood turn per harness and assert the matrix on
what actually persisted and rendered:

1. Start the inner instance (`shipit service start dev`; the
   `dogfooding-shipit` skill has the drill). All three harnesses are baked
   into the dogfood image. **Run turns strictly serially** — local mode
   applies credentials to process-global env around each spawn.
2. One fresh session per harness: `POST /api/sessions/headless` with
   `agent: "claude" | "codex" | "opencode"` and the tour prompt; poll
   `GET /api/sessions/:id/status`.
3. Assert on `GET /api/sessions/:id/history` (persisted truth, not the
   live socket): per matrix row, the dedicated artifact — `diffStats`
   present on the edit/write messages; the task-tool calls carry their
   panel keys post-projection and their results carry the created ids;
   the subagent call has its report attached; every observed tool name
   passes the Step-2 registry checks.
4. Open the inner UI on the session (Playwright: `browser_navigate` +
   `browser_snapshot`) and confirm the rendered treatments: task panel
   visible with the three items completed, diff blocks (not bare rows)
   for the edit and write, subagent card, specific activity labels in the
   scrollback. Then **reload the page** and snapshot again — rehydration
   from persisted history is where the planning#337 class also hides
   (`foldTaskList` returning null renders *no panel at all*, which a
   live-stream-only check misses).
5. **Negative control** (the docs/262 probe lesson: a check that cannot
   fail is worthless — its `settings.greeting` and dependency fields
   passed for two full runs while broken, because they couldn't
   distinguish). Prove your checker can go red: feed it one synthetic
   message with a fabricated tool name (`TaskCreateV2`) and confirm it
   flags the unmapped name and the missing artifact. Do this once per
   checker change, not per run.

### Step 5 — record what you saw

"A pass is not 'it worked'." Every run gets its **own file** under
[runs/](runs/), named
`runs/YYYY-MM-DD-HHMM-<harness>-<cli-version>.md` (UTC start time, so the
listing sorts chronologically), with the run metadata in a `run:`
frontmatter block — harness, CLI + version, the pin at run time, date,
capture/live models, which steps ran, where the raw capture lives, and
the verdict. (The docs-list parser reads only line-anchored `issue:` /
`title:` / `description:`; nested keys under `run:` are ignored by it and
safe.) The body records the three Step-2 inventories (or their delta from
the previous run's file), and per matrix row the artifact actually
observed (e.g. "task panel: 3 items, ids task-1..3 parsed from results,
survived reload"). A bump PR links its run file. Comparable per-run files
are what turn the next bump into `diff runs/<old> runs/<new>` instead of
a rediscovery — the first recorded run,
[runs/2026-08-17-1638-claude-2.1.224.md](runs/2026-08-17-1638-claude-2.1.224.md),
is the template to copy.

## The version-bump subset (req 3)

For a routine Renovate bump PR, the full recipe compresses to:

1. Step 1 capture with the candidate version (one tour turn per bumped
   CLI).
2. Step 2 inventory diff against the previous recorded inventory — no
   delta in names, event types, input keys, or result shapes → record
   that and stop; the existing conformance tests already lock the
   behavior.
3. Any delta → Step 3 recapture + Step 4 for the affected surfaces, and
   the registry updates the delta demands ship **in the bump PR**, not
   after.

Walkthrough against the precedent: on the 2.1.220 bump, Step 2 shows
`TodoWrite` absent from the tour stream and four unknown-to-the-registries
`Task*` names present — they mapped in `tool-map.ts`, but the *pre-fix*
`TASK_LIST_TOOL_NAMES` held only `TodoWrite`, so no recognition registry
claimed them (today's membership is the post-d409940c fixed state; don't
read it back into the precedent); Step 4 shows no task panel in the UI and
stripped inputs in history. The break surfaces on the bump PR, red, with the exact
failing surface named — instead of weeks later via a user.

## Why both fixtures and a live turn (mechanism decision)

The commissioning brief asked whether the mechanism is an executable probe
(docs/262 pattern), captured-fixture conformance tests, or both. **Both,
split by what each can see** — which is where the codebase had already
landed, half-consciously:

- **Captured-fixture conformance tests** own Layer A/B: deterministic,
  offline, free, and they lock a version's behavior forever after. But a
  fixture is a frozen claim about the CLI — it cannot detect that the CLI
  moved. Its staleness is exactly what the recapture ritual exists for.
- **The live tour turn** owns "what does this CLI version actually emit"
  (the only ground truth a rename can't hide from) and Layer C's
  process/environment facts. docs/268's Phase 10 findings were all in this
  category — `$PWD` beating spawn cwd, the process never exiting with MCP
  servers attached — invisible to any fixture by construction.

A permanent CI probe service (full docs/262 shape) is **not** proposed:
tour turns cost real model calls and real money per run, the dogfood inner
instance can't run in CI today, and the cadence that matters (version
bumps) is exactly when a human is already on a Renovate PR. The
automation that *is* worth building is docs/141 Axis 3, which steps 1–3
define the assertions for.

## Follow-up tooling (tracked in planning#430; not built in this PR)

1. **docs/141 Axis-3 CLI contract test** — automate steps 1–3 as the
   required check on Renovate bump PRs; flip auto-merge on once it gates.
2. **Advertised-inventory diff** — the CLI's own advertised tool list is
   already typed on `agent_init.tools` (`agent-types.ts`) and consumed
   nowhere; diff it against `<X>_TOOL_NAMES` at spawn or in the contract
   test, so a wholly new tool name is flagged without a tour.
3. **Unknown-name sentinel** — log (dev-warn) when a transcript carries a
   tool name no registry recognizes, as a tripwire (planning#337 proposed
   exactly this; it was to be `canonicalizeTool`'s first production call
   site, but the tool map was removed on 2026-09-02, so a sentinel would key on
   `<X>_TOOL_NAMES` or the normalizer tables instead).
4. **Recognition conformance harness** — replay captured turns through
   grouping + projection + the client folds and assert the matrix
   mechanically, so Step 4's assertions stop being manual.

Shipped alongside this recipe: `tool-map.test.ts` ran the
advertised-name guard over `OPENCODE_TOOL_NAMES` too (it covered only
claude and codex; OpenCode had zero coverage). 2026-09-02: that test went with
the tool map; `opencode-tool-normalizer.test.ts` still covers every
advertised OpenCode name.

## Appendix — the literal-name registries

The load-bearing inventory: every place a raw tool name decides treatment.
A verification run's Step-2 registry check walks this table; a rename can
land in any row. (Line numbers drift; the identifiers don't.)

| Registry | File | Decides | Unknown-name behavior |
|---|---|---|---|
| `AGENT_TOOL_MAPS` / `canonicalizeTool` | **removed 2026-09-02** (was `session/agents/tool-map.ts` + per-harness slices) | nothing — was guard vocabulary with no runtime caller | n/a |
| `<X>_TOOL_NAMES` | `shared/agent-tool-names.ts` | adapter `capabilities`; the normalizer tests check `<X>_TRANSCRIPT_TOOL_NAMES` against it (opencode: full coverage; grok: every named tool is advertised) | n/a (hand list) |
| `TASK_LIST_TOOL_NAMES` + `TASK_LIST_SUMMARY_KEYS` | `shared/task-list-tools.ts` | panel membership + which input keys survive | falls out of panel; keys **dropped** |
| `inputKeyTreatment` (`WHOLE_INPUT_TOOL_NAMES`, `SUMMARY_KEYS`, plan-doc marker) | `shared/transcript-input-policy.ts` | which input fields reach the wire | **default `drop`** — data loss |
| `rendersResultContentInline`, `SUBAGENT_TOOL_NAMES`, `SUBAGENT_REPORT_TOOL_NAMES`, `WHOLE_RESULT_TOOL_NAMES` | `shared/transcript-slice-tools.ts` | result-body projection, subagent layout/report | unknown → result **stripped** |
| `isPresentTool` / `parseMcpToolName` | `shared/tool-names.ts` | present chip, MCP chip parsing | generic |
| `DIFF_INPUT_TOOLS` | `orchestrator/.../transcript-projection.ts` | `diffStats` computation | no diff stats |
| `STANDALONE_MERGE` | `orchestrator/.../agent-message-builder.ts` **and a literal duplicate in** `client/hooks/message-handlers/agent-event.ts` | bubble merging | bubbles split |
| `EnterPlanMode` / `ExitPlanMode` / `isWellFormedAskUserQuestion` interrupt gates | `orchestrator/.../agent-listeners.ts`, `agent-event-normalizer.ts` | turn interrupt, permission-mode bookkeeping | **no interrupt** — agent runs past the user |
| `HANDLED_INTERRUPT_TOOLS` | `orchestrator/.../permission-broker.ts` | auto-allow without a card | dead-end permission card |
| `VOICE_NOTE_TOOL_NAME` | `orchestrator/.../voice-note-router.ts` | voice card | no card |
| `ToolUseItem` if-ladder, `TOOL_ICONS`, `isCommandTool` | `client/components/message-tools.tsx` | diff blocks, question card, plan chip/card, icons | generic row, raw-text label |
| `foldTaskList` / `applyTaskCall` / `CREATED_TASK_ID` result regex | `client/components/task-list.ts` | the task panel itself | **panel absent** |
| `STANDALONE_TOOLS` / `isStandaloneTool` | `client/components/visual-elements.ts` | standalone vs clipped tool-group | card clipped out of sight |
| `activityFromTool` switch + `BROWSER_LABELS` | `client/components/StreamingIndicator.tsx` | live activity label | `Using <name>...` (benign-looking) |
| `findPlanContent` / `isPlanDocumentWrite`, `ExitPlanMode` gates | `client/components/MessageList/` | plan card body on reload, subagent card | blank plan card / Skill-chip fallback |

Also name-shaped but not tool names, same silent-drop class: Claude
`system.subtype` strings (`default: return null`) and Codex item types
(`default: break`) in the adapters, and `mcp__<server>__<tool>` parsing.

## Key files

- `src/server/session/agents/<id>/adapter.ts`, `adapter.test.ts` — Layer A
  + the capture-backed conformance tests (`tool-map.ts` removed 2026-09-02)
- `src/server/shared/agent-tool-names.ts`, `task-list-tools.ts`,
  `transcript-input-policy.ts`, `transcript-slice-tools.ts`,
  `tool-names.ts` — Layer B registries (server-shared)
- `src/server/orchestrator/ws-handlers/agent-listeners.ts`,
  `agent-message-builder.ts`, `agent-event-normalizer.ts`,
  `permission-broker.ts`, `transcript-projection.ts` — Layer B/C
  orchestrator
- `src/client/components/message-tools.tsx`, `task-list.ts`,
  `visual-elements.ts`, `MessageList/`, `StreamingIndicator.tsx`,
  `src/client/hooks/message-handlers/agent-event.ts` — Layer C client
- `docs/141-cli-version-strategy/` — the bump pipeline this recipe gates
  by hand until Axis 3 exists
- `docs/262-plugins/real-instance-e2e.md` — the record-what-you-saw and
  negative-control discipline this recipe borrows
