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

Both questions this spike raised are held in
`docs/291-ripwire-context-map/requirements.md` § "Open questions", alongside the
ripwire version-pin question, because they gate adopting *any* MCP retrieval
server and are not specific to LemonCrow:

- **Question 2** — is advertisement filtering enough, or does ShipIt need real
  per-server tool authorization? Gates requirement 1.
- **Question 3** — what does "must not change an existing session" require? Gates
  requirement 6.

They are not restated here, because two copies of a question drift. The evidence
behind both stays in this folder: [plan.md](plan.md) § "Constraining the tool
surface" and § "Opt-in and existing sessions".

## Resolved questions

- 2026-09-07 — *Does "build the spike" mean shipping an enabling change to
  ShipIt?* No. Nik's brief for this session said "opt-in and off by default;
  confirm with the user before any change that would affect existing sessions",
  and requirement 8 gates adoption on the evidence. This PR therefore ships
  evidence, a verdict, and the open questions; it changes no ShipIt behaviour.
- 2026-09-07 — *Can LemonCrow's tool surface be narrowed without a ShipIt
  change?* Partly, and this was answered by testing rather than by asking:
  `LEMONCROW_HIDE_TOOLS` reduces the advertised surface to `code_search` and
  `read`. It does not reject a direct call to a hidden tool, which is why
  `docs/291-ripwire-context-map/requirements.md` question 2 is about
  authorization and not about configuration.
