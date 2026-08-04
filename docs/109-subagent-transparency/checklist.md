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

## Collapse the work timeline by default

- [x] Default the work disclosure to collapsed in every state (running + finished)
- [x] Keep the live action count on the toggle so the collapsed row still signals activity
- [x] Component tests for the collapsed default (streaming, finished) and the user toggle
- [x] Update the two `MessageList` cases that asserted an expanded-by-default timeline

## Final report formatting (2026-08-04)

- [x] `requirements.md` written from what the human asked for, with dated receipts
- [x] Prototype committed as `mockup-final-report.html` and presented before building
- [x] Recognise the background-launch acknowledgement; render a running row, not a report (reqs 1–2)
- [x] `in background` badge so the card stops claiming `done` for a running subagent (req 2)
- [x] Report panel — border, label row, opaque body (req 3)
- [x] Flattened markdown scale + 78ch measure (req 4)
- [x] Accounting footer → duration / tools / tokens chips; `agentId` dropped in the parser (req 5)
- [x] Clamp long reports with a fade (req 6)
- [x] *Show the full report* opens a modal (req 7)
- [x] Report leaves `WHOLE_RESULT_TOOL_NAMES`; `sliceSubagentReport` clamps it for the wire (req 8)
- [x] Modal fetches the rest from `/api/sessions/:id/tool-results/:toolUseId` (req 8)
- [x] Nested (subagent-of-a-subagent) reports still ship whole on the live path — their row
      is not committed, so there is nothing for the modal to fetch from yet
- [x] Error variant on the same panel shell, monospace body (req 9)
- [x] Tests: shared module, component, projection, integration; the docs/244 guard tests
      re-pinned to the new contract
- [x] `npm run typecheck` + `npm run lint:dev` clean
- [x] Independent cross-agent review against the numbered requirements (Codex).
      Four findings fixed: the clamp is now *measured* rather than inferred from
      source lines (a 3-line report holding a 40-row table got no clamp and no
      button); `isBackgroundLaunchAck` gained a length bound so a long report
      quoting the CLI's sentence can't be swallowed; a lone footer-shaped block
      is treated as the footer instead of rendered as prose with `agentId` in
      it; and `sliceSubagentReport` rebuilds the block array in place so a
      report's image survives, with URL substitution running before the clamp.

## Not done

- [ ] A **nested** report (a subagent's subagent) still renders through the generic
      `ToolResult` path rather than `SubagentCall`, so it shows raw block JSON
      including the accounting footer, and reaching it takes two clicks (open the
      work disclosure, then the tool modal). Predates this change; surfaced by the
      independent review. Fixing it means routing report tools to `SubagentCall`
      inside the work timeline too.
- [ ] Requirement 8 is relaxed for a **live** nested report: it ships whole because
      its row is not committed yet, so there is nothing for a fetch to resolve
      against. Bounded on the next history load. Rationale in `plan.md`.
- [ ] Verify the shipped card in a live browser render. The component and integration tests
      cover behaviour and the compiled CSS was checked for every new utility, but no live
      subagent card was rendered — the inner dogfood instance would need a real subagent turn.
- [ ] Per-subagent duration / token usage in the header — the CLI does not expose
      per-subagent usage in its event stream, only the parent turn's totals.
      Blocked on upstream; the data flow is ready to plumb it through.
      (Partly superseded: when the CLI's accounting footer IS present, its
      `duration_ms` / `tool_uses` / `subagent_tokens` now render as header chips.)
- [ ] Confirm whether a **subagent-backed** skill attaches nested events to the
      `Skill` tool id. Evidence points to no (its result arrives as a separate
      task notification), but this was not exercised against a live run. If it
      does, add `Skill` to `SUBAGENT_REPORT_TOOL_NAMES` and give `SubagentCall`
      a skill-shaped header.
