# 109 — Subagent transparency checklist

## Original feature

- [x] Preserve `parent_tool_use_id` on normalized agent events (`ClaudeAdapter.mapEvent`)
- [x] Route nested events into the parent group's `subagentEvents` (`agent-listeners.ts`)
- [x] Persist `subagent_events` on the parent message (migration 10)
- [x] `groupEventsByParent` util — tree the flat event list by parent id
- [x] `SubagentCall` component — header, prompt, work timeline, final report
- [x] Live streaming of the work timeline
- [x] Codex `spawn_agent` normalized into the `Agent` tool-use shape

## Renderer gate mismatch — the feature was dark in production

- [x] Confirm against a live CLI run which tool name is actually emitted (`Agent`, CLI 2.1.219)
- [x] Split `SUBAGENT_TOOL_NAMES` into a layout set and a report set
- [x] Gate `SubagentCall` on the report set instead of the literal `"Task"`
- [x] Keep `Task` in the report set for transcripts persisted before the fix
- [x] Drop `Skill` from the slice exemption (renders no report — docs/244 finding)
- [x] Client regression tests using the real `Agent` name (fail against the pre-fix renderer)
- [x] Switch `integration_tests/subagent-transparency.test.ts` off the synthetic `Task`
- [x] Verify against a real browser render, not just unit tests
- [x] `npm run typecheck` + `npm run lint:dev` clean

## Not done

- [ ] Per-subagent duration / token usage in the header — the CLI does not expose
      per-subagent usage in its event stream, only the parent turn's totals.
      Blocked on upstream; the data flow is ready to plumb it through.
- [ ] Confirm whether a **subagent-backed** skill attaches nested events to the
      `Skill` tool id. Evidence points to no (its result arrives as a separate
      task notification), but this was not exercised against a live run. If it
      does, add `Skill` to `SUBAGENT_REPORT_TOOL_NAMES` and give `SubagentCall`
      a skill-shaped header.
