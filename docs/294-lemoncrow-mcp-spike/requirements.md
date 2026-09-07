---
title: LemonCrow MCP-only spike
description: What the opt-in, MCP-only LemonCrow spike must establish before ShipIt adopts or rejects it
---

# LemonCrow MCP-only spike

planning#332 rejected LemonCrow in its tool-replacement mode and recommended one
thing instead: spike the MCP-only, opt-in shape behind a measurement gate, and
reject it if it does not clear that gate. Nobody built it. This is that spike.

1. Establish whether LemonCrow can be added to a ShipIt session as an
   **additional** retrieval tool — added, never substituted — so that no tool
   ShipIt's guards, transcript, or product principles depend on is hidden,
   renamed, replaced, or steered away from.
2. Establish what the vendor's installer actually does in global mode (no
   `--project`), by reading and running the installer itself rather than its
   documentation. A premise that turns out to be false is a result: report it
   instead of building on it.
3. Re-test each of the three blockers planning#332 found against the additive
   shape. For each, say whether it fires, and name the code location that
   decides the answer.
4. Measure retrieval on the same six task phrases, the same gold answer sets and
   the same tokenizer as `docs/291-ripwire-context-map/measure.py`, so LemonCrow
   and ripwire are comparable. Report **cost and recall together** — a cheap
   answer that misses is not a saving.
5. State what the measurement does not establish, so a reader cannot mistake its
   scope: which phase of the work it covers, what the tokenizer figure is a
   proxy for, and what the recall check can and cannot fail on.
6. Anything ShipIt adopts from this must be opt-in and off by default. Enabling
   it must not change a session that already exists.
7. Report what a ShipIt session container pays to run LemonCrow at all —
   processes, resident memory, disk inside the clone, and network egress.
8. Recommend adopt or reject on the measured evidence, and say what would change
   the answer.

## Open questions

The adoption-gating questions are held in one place —
`docs/291-ripwire-context-map/requirements.md` § "Open questions" — because they
gate adopting *any* MCP retrieval server and are not specific to LemonCrow.
**Whether ShipIt needs per-server MCP tool authorization** lives there. The
evidence behind it stays here, in [plan.md](plan.md) § "Constraining the tool
surface": LemonCrow can be reduced to a retrieval-only *advertised* surface today
with no ShipIt change, but a hidden tool still executes when called by name.

One question has not reached that shared list yet, so it is held here rather than
dropped:

- **What does "must not change an existing session" require here?** Enabled MCP
  servers are read from the account-wide credential store when a turn's run
  parameters are built, not snapshotted at session creation
  (`session-agent-run-params.ts:111`), so a session that already exists picks up
  a newly enabled server on its next turn. Requirement 6 therefore cannot be met
  by the existing settings surface alone. Whether requirement 6 means per-session
  opt-in, or only "off until someone turns it on", is the human's call. Move this
  to the shared list and replace it with a pointer once it is there — keeping it
  in two places is what this consolidation exists to prevent.

## Resolved questions

- 2026-09-07 — *Does "build the spike" mean shipping an enabling change to
  ShipIt?* No. Nik's brief for this session said "opt-in and off by default;
  confirm with the user before any change that would affect existing sessions",
  and requirement 8 gates adoption on the evidence. This PR therefore ships
  evidence, a verdict, and the open questions; it changes no ShipIt behaviour.
- 2026-09-07 — *Can LemonCrow's tool surface be narrowed without a ShipIt
  change?* Partly, and this was answered by testing rather than by asking:
  `LEMONCROW_HIDE_TOOLS` reduces the advertised surface to `code_search` and
  `read`. It does not reject a direct call to a hidden tool, which is why the
  authorization question in `docs/291-ripwire-context-map/requirements.md` is
  about authorization and not about configuration.
