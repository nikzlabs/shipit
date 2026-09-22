# Checklist — propose a message to an unreachable session

- [x] `requirements.md` written and open questions resolved
- [x] `plan.md` written
- [x] Shared validation module + its test
- [x] `SessionMessageProposalCard` domain type; `SessionMessageOrigin.relation` gains `"proposed"`
- [x] WS card + update messages
- [x] DB column, migration, `toRow`/`fromRow`, `find`/`update` in `chat-history.ts`
- [x] `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE` extended (guard tests green)
- [x] `deliverSessionMessage` extracted from `sendChildMessage`
- [x] Propose route (container-accessible) with every call-time refusal
- [x] Deliver route (browser only) with re-resolution and in-flight guard
- [x] MCP tool registered on the bridge and in all five adapter tool specs; worker relay route
- [x] Client card, message handlers, dispatch + `TRANSCRIPT_SCOPED_MESSAGES`, `App.tsx` wiring
- [x] `TranscriptRow` origin label map, including the `"proposed"` wording
- [x] `CHILD_NOT_FOUND` points at the tool and says *direct child*
- [x] Integration tests: refusals, root target, sibling target, double-click, archived-after-card
- [x] `sendChildMessage` still refuses a root, a sibling and a grandchild after the extraction
- [x] Card component test
- [x] `/shipit-docs/sessions.md` and the five system prompts corrected: the reach is direct
      children, and the dead end names the tool
- [x] `wiki/sessions.md` describes the card for the user
- [x] `npm run lint:dev` and `npm run typecheck` clean
- [x] Independent review collected and answered (6 findings; every one acted on)
  - [x] A post-dispatch failure never marks the card retryable (pinned by a test
        that goes red without the guard)
  - [x] `queued` comes from the dispatch's own admission, not `runner.running`
  - [x] The expander is offered on MEASURED overflow, so a short clipped message
        is still readable in full
  - [x] The repository-trust admission is checked at propose time, not left to
        fail under the click
  - [x] The in-flight lock is released when the first persist throws
  - [x] The deliver response updates the card, for a session with no runner
  - [x] Factual corrections: `session report` reaches the direct parent (now
        refused and pointed at), and `list` uses `findChildren`
- [x] PR opened with `Closes planning#450`
