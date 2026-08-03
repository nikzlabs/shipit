# Checklist — sub-agent result delivery (SHI-245)

- [x] `runAgentToCompletion` joins every completed assistant message instead of
      keeping the last one (dedupes an adapter's verbatim re-emit)
- [x] `runSubAgent` returns `spawnId`; card and stdout provably share one string
- [x] `ChatHistoryManager.listSubAgentConsultCards`
- [x] `getSubAgentResult` service (latest / by id / unambiguous id prefix)
- [x] `GET /api/sessions/:id/agent/result` + `/agent-ops/agent/result` broker leg
- [x] `shipit agent result [RUN-ID] [--json]` shim subcommand + help text
- [x] `shipit agent run` prints the run id and how to re-read it
- [x] SIGTERM handler so a killed run says where its output will be
- [x] `shipit-docs/agent.md`: parity, background-run guidance, `agent result`
- [x] Tests: multi-message capture, card/stdout parity, lookup, shim, broker,
      chat-history read
- [x] Fix: a card emitted after its turn finalized is appended as a final row
      instead of being written into (and then deleted with) a revived
      in-progress turn — the backgrounded-consult data loss. Complements SHI-278
      below: that moved card creation mid-turn, this covers a launch that is
      itself post-turn (a background shell started in an earlier turn).

## Follow-on (SHI-278 — tracked in docs/144 §7a)

- [x] Backgrounding needed a durable in-flight surface; the emit-only spinner
      §5's guidance relied on did not survive a session switch. Fixed in
      `docs/144-cross-agent-review` §7a — see that doc's checklist.
