---
issue: planning#337
title: "045: The agent's to-do list in the transcript"
description: The task panel — how the agent's to-do list is folded out of its tool calls and drawn inline.
---

# 045: The agent's to-do list in the transcript

## Problem

The agent maintains a to-do list while it works. Without a renderer for it, each
call falls through to the generic one-line tool summary and the raw tool-call
modal, and the user cannot see the list at all.

## Design

Draw the list **inline in the message list**, at the point where it last
changed. There is at most one panel in the transcript, so the user has a
persistent view of the current state without a floating panel disconnected from
the conversation.

### Two tool models, one panel

The CLI has changed how it exposes the list, and the panel supports both.

| | `TodoWrite` (CLI ≤ 2.1.219) | `TaskCreate` / `TaskUpdate` (CLI 2.1.220+) |
|---|---|---|
| Shape | **Declarative** — every call carries the whole list in `input.todos` | **Incremental** — a create adds one task, an update patches one task by id |
| Task id | none (positional) | assigned by the CLI, returned in the **tool result** (`Task #1 created successfully: …`) |
| To draw the list | read the latest call | fold the whole call sequence |

`TodoWrite` is still supported. Sessions persisted before the rename have it in
their history, and dropping it would blank their panel on reload.

`TaskList` and `TaskGet` are read-only. They render as nothing — the panel
already shows what they would report — but they never move the panel.

**`TaskStop` and `TaskOutput` are not to-do list tools.** They share the prefix
and act on a *background* task (a shell, an agent, a remote session), so they
stay ordinary tool lines with their own activity labels.

### The list is derived, never stored

`foldTaskList` (`client/components/task-list.ts`) replays the calls in
`messages` on every render. The calls already survive a history load, a fork, a
thread switch and a session resume, so a store holding the folded list would
only be a second copy to keep in sync with them.

The fold is pure and total, which is what makes the mid-turn case work: a
`TaskCreate` whose result has not arrived yet gets a provisional
`pending-<toolUseId>` key and settles onto its real id the moment the result
lands, with no state to migrate.

Two cases the fold handles deliberately:

- **A create still streaming in** has no `subject` yet. It is skipped, so the
  panel never shows an unlabelled row; the next render folds it in.
- **An update naming a task whose create is gone** (compaction dropped it) is
  adopted when the update carries a `subject`, and ignored when it doesn't —
  an id alone would render as a blank line.

### The panel is its own visual element

`buildVisualElements` emits `{ kind: "task-panel", tasks, messageIndex }` after
the message holding the last list-changing call.

It has to be a top-level element rather than something a message bubble draws.
The calls carry no text, so the anchoring message usually produces no bubble;
and when it also holds an ordinary tool it produces a *tool-group* instead. The
old `TodoWrite` renderer anchored to the bubble and disappeared in exactly those
cases.

### Keeping the panel intact after a reload

The panel draws its rows with no click behind it, so the keys it reads must
survive the docs/244 wire projection — otherwise the panel is right live and
loses its rows on the next history load.

`inputKeyTreatment` keeps `taskId`, `subject`, `activeForm` and `status` on the
task tools (`TASK_LIST_SUMMARY_KEYS`). It is a **key set, not a whole-input
exemption**: `description` is the one long field these tools carry, the panel
never draws it, and keeping bodies like that off the wire is what docs/244
exists for.

These calls render as the panel and nothing else, so — unlike every other
`drop` in that policy — there is no tool line to click and no modal behind
them. `description` is dropped with no UI that fetches it back. Nothing
displayed it before either, so nothing is lost; but it makes adding a field to
the panel two edits, the renderer and the key set. The value stays on disk for
a future detail view.

**`TaskCreate`'s RESULT matters too, and for a different reason.** The CLI
assigns the task id and returns it only there. So `TaskCreate` is a member of
`rendersResultContentInline` (`transcript-slice-tools.ts`): without it the
projection empties the result on the serve path, the task stays stranded on its
provisional key, and every later `TaskUpdate` misses it. Only the head of that
string is needed, so the ordinary slice suffices — it is not a
`WHOLE_RESULT_TOOL_NAMES` member.

### A rejected call changes nothing

The fold skips any call whose result carries `isError`. Applying them
optimistically left a phantom row behind a denied `TaskCreate`, and showed a
failed completion or delete as though it had worked.

## Key files

| File | Role |
|---|---|
| `src/server/shared/task-list-tools.ts` | `TASK_LIST_TOOL_NAMES` / `isTaskListTool` / `TASK_LIST_SUMMARY_KEYS` — one definition, read by both the client renderers and the server projection |
| `src/client/components/task-list.ts` | `foldTaskList` — rebuilds the list from the call sequence |
| `src/client/components/TodoPanel.tsx` | the panel; presentational, never reads a tool call |
| `src/client/components/visual-elements.ts` | emits the `task-panel` element; keeps the task tools out of the clipped tool group |
| `src/client/components/MessageList/MessageList.tsx` | renders the element |
| `src/client/components/message-tools.tsx` | returns `null` for a task-list call — the panel draws it |
| `src/server/shared/transcript-input-policy.ts` | keeps the keys the panel reads on the wire |
| `src/client/components/StreamingIndicator.tsx` | activity labels |
| `src/server/session/agents/claude/tool-map.ts` | canonical `task` / `todo` names |

## Why the rename went unnoticed

Nothing failed when the CLI replaced the tool. Every renderer matched on the
literal string `TodoWrite`, so the panel silently stopped rendering and the new
calls degraded to the generic fallback — a working-looking transcript with a
missing feature.

The first guard against a repeat is in `tool-map.test.ts`: every name in
`CLAUDE_TOOL_NAMES` / `CODEX_TOOL_NAMES` must have a canonical mapping. It
catches a name that was added to the advertised list but wired to nothing. It
does **not** catch a name the CLI added and we never listed — that needs a check
against what the CLI actually advertises at runtime.

## Verification

1. `npm run typecheck`, `npm run lint:dev`
2. `npx vitest run src/client/components src/server/shared/transcript-input-policy.test.ts src/server/session/agents/tool-map.test.ts`
3. Manual: ask the agent for a multi-step job → the panel appears and updates in place as tasks move to in-progress and completed
4. Manual: reload the page → the panel renders the same rows from history
5. Manual: a session recorded before CLI 2.1.220 → its `TodoWrite` panel still renders
