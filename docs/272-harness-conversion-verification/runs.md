---
title: Verification runs — recorded results
description: Recorded docs/272 recipe runs, per harness and CLI version. A pass is not "it worked" — each run records the actual inventories and artifacts observed.
---

# Recorded verification runs

Append one section per run. Comparable records are what turn the next
version bump into a diff instead of a rediscovery.

## Run 1 — Claude Code 2.1.224 (2026-08-17, first exercise of the recipe)

- **Harness**: claude · **CLI**: `@anthropic-ai/claude-code` 2.1.224 (the
  current `docker/agent-cli/package.json` pin) · **Date**: 2026-08-17
- **Step 1 capture**: direct CLI run in a session container
  (`claude -p … --output-format stream-json --verbose`), model
  `claude-haiku-4-5-20251001`, sandbox cwd. 119 NDJSON events. Raw capture
  kept at `/persist/tour-claude/capture-2.1.224.ndjson` (not committed).
- **Step 4 live run**: dogfood inner instance, Claude harness redirected
  to DeepSeek (`deepseek-v4-flash`, metered ≈ $0.01) — see the
  environmental findings for why not Anthropic-native. Model choice does
  not affect the event schema under test; the CLI emits the same stream.

### Step 2 inventories (capture, Haiku turn)

Event types/subtypes observed:
`system:init` 1, `system:thinking_tokens` 54, `rate_limit_event` 1,
`assistant` 38, `user` 19, `system:task_started` 1,
`system:task_progress` 2, `system:task_updated` 1,
`system:task_notification` 1, `result:success` 1.

Tool names observed (all pass every membership check —
`CLAUDE_TOOL_NAMES`, `claude/tool-map.ts`, and their surface's
recognition registry):
`TaskCreate` 3, `TaskUpdate` 6, `ToolSearch` 1, `Read` 1, `Write` 1,
`Edit` 1, `Bash` 4, `Agent` 1.

Input keys observed, all as the registries expect: `TaskCreate:
description,subject(,activeForm in the dogfood run)`, `TaskUpdate:
status,taskId`, `Edit: file_path,new_string,old_string,replace_all`,
`Write: content,file_path`, `Bash: command,description`, `Agent:
description,prompt,run_in_background`. `activeForm` did not appear in
every `TaskCreate`; it is optional, and `TASK_LIST_SUMMARY_KEYS` covers
it either way.

Result shapes: `TaskCreate` → `Task #<n> created successfully: <subject>`
and `TaskUpdate` → `Updated task #<n> status`, both matching
`task-list.ts`'s `CREATED_TASK_ID` prose regex (verified on all 9
task-tool results of the live run).

### Step 4 recognition matrix (dogfood run, persisted history + UI)

| Surface | Observed artifact | Pass |
|---|---|---|
| File write | `Write` chip with `+2` diff badge and Show diff | ✓ |
| File edit | `Edit` chip with `+1 −1` diff badge | ✓ |
| To-do / task write | Task panel "Tasks 3/3 completed" with all three subjects; `subject`/`status`/`taskId`/`activeForm` present in persisted inputs; ids parsed from results; no generic rows for the 9 task calls | ✓ |
| Read / search / shell | `Grep` chip with pattern; Bash rendered as command line | ✓ |
| Subagent | Full `SubagentCall` card: subject, "done", "Prompt (454 chars)" (prompt projected off the wire, `inputChars` stub kept), "Subagent's work (2 actions)", inline final report | ✓ |
| Persistence / reload | Full page reload → identical rendering of all of the above from rehydrated history | ✓ |
| Negative control | Fabricated `TaskCreateV2` scores 0 in both name lists — the membership check can go red | ✓ |

`diffStats` note: the history payload carried no `diffStats` fields —
these small edit bodies were persisted whole (below the truncation
threshold), so the client renders diffs from the full inputs;
`diffStatsFor` only stamps a summary when the body is projected away.
The matrix artifact is the rendered diff badge, which was present.

### Findings

1. **Two observed subtypes fall through the adapter's bare default.**
   `system:thinking_tokens` (54× — the single most frequent event in the
   stream) and `system:task_progress` (2×) hit `mapEvent`'s
   `default: return null` in `claude/adapter.ts`. Unlike
   `task_started`/`task_updated`, which are *named* cases with a
   documented deliberate-drop rationale (docs/235), these two are
   undocumented silent drops — indistinguishable, in code, from a subtype
   nobody has noticed yet. Recommendation: promote both to named cases
   (drop-with-rationale, or map them). Recorded on planning#430.
2. **Environmental, not conversion** (dogfood-local, for the record):
   planning#358 reproduced verbatim — the seeded `anthropic:sub` route
   reads `ready` and the Haiku turn died with "This agent is not
   authenticated" in under 10 s; background session-naming (pinned
   claude-opus-5 · subscription) failed the same way. Separately, the
   inner session's auto-commit failed with "Author identity unknown"
   (no git user configured in the local-mode inner workspace).

**Verdict: PASS for Claude Code 2.1.224** — every observed tool name is
recognized, every exercised surface produced its dedicated artifact, and
rendering survived reload. Finding 1 is a robustness gap in the event
(not tool) vocabulary, tracked for follow-up.
