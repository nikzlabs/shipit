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
   renamed, or replaced.
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
5. Carry the same stated limits as that measurement: it covers the orientation
   phase only, and tiktoken is a proxy for Claude's non-public tokenizer.
6. Anything ShipIt adopts from this must be opt-in and off by default. Enabling
   it must not change a session that already exists.
7. Report what a ShipIt session container pays to run LemonCrow at all —
   processes, resident memory, disk inside the clone, and network egress.
8. Recommend adopt or reject on the measured evidence, and say what would change
   the answer.

## Open questions

- The measurement gate was **cleared** — LemonCrow reaches full parity on the
  gold answers for 3,878 tokens against ripwire's 18,679 (`plan.md` § "The
  measurement gate"). But adoption is not unblocked by that alone: LemonCrow's
  MCP surface includes `bash` and `edit`, and ShipIt auto-allows every enabled
  user MCP server's whole `mcp__<name>__*` namespace, so enabling it also adds
  an unguarded second shell. Should ShipIt gain a way to restrict which tools an
  individual MCP server may expose, so LemonCrow can be enabled retrieval-only —
  and is that restriction LemonCrow-specific or general to all user MCP servers?

## Resolved questions

- 2026-09-07 — *Does "build the spike" mean shipping an enabling change to
  ShipIt?* No. Requirement 8 gates it: the spike measures first, and requirement
  6 forbids changing existing sessions without a decision. This PR therefore
  ships evidence, a verdict, and the open question above; it changes no ShipIt
  behaviour.
