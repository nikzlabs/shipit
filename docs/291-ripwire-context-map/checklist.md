# Checklist

- [x] Verify ripwire retrieval accuracy on ShipIt's own source (3 known-answer queries)
- [x] Check reported line numbers and signatures against the files
- [x] Test `--test-gate`, `--doc-drift` and `--quality-delta` on this repository
- [x] Probe the MCP server and record the tool surface
- [x] Record release, contributor and version-age risk
- [x] Re-check the planning#332 LemonCrow blockers against today's code on both sides
- [x] Measure the token saving with a real tokenizer, without integrating anything (`measure.py`)
- [x] Run the observed A/B against real agents, all six task pairs (`pair.sh`, `analyse.py`)
- [x] Revise the recommendation to match what was measured (req 1 is **not met**)
- [x] Run the same end-to-end A/B for LemonCrow as a third arm (`lcarm.sh`, `lcsearch.py`)
- [x] Explain why context tokens and cost disagree (cache reads bill per turn)
- [x] Verify and document the MCP whole-namespace guard gap at source
- [x] Document the reproduction steps and environment gotchas
- [x] Hold all three adoption-gating open questions in one place (`requirements.md`)
- [ ] Decide the pinned version — **moot unless the verdict is overridden**; the recommendation is now not to adopt

Only if the not-adopt verdict is overridden:

- [ ] Add the pinned binary and checksum verification to the session-worker Dockerfiles
- [ ] Write one skill for the `--for` lens — and make it fire conditionally, not "run it first"
- [ ] Update `src/server/shipit-docs/` for the new agent-facing command
- [ ] Verify `ripwire --version` inside a built session container
