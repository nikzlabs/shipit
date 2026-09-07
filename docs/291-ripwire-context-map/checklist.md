# Checklist

- [x] Verify ripwire retrieval accuracy on ShipIt's own source (3 known-answer queries)
- [x] Check reported line numbers and signatures against the files
- [x] Test `--test-gate`, `--doc-drift` and `--quality-delta` on this repository
- [x] Probe the MCP server and record the tool surface
- [x] Record release, contributor and version-age risk
- [x] Re-check the planning#332 LemonCrow blockers against today's code on both sides
- [ ] Decide the pinned version (v0.3.8, or v0.4.0 with a waiver) — open question in `requirements.md`
- [ ] Add the pinned binary and checksum verification to the session-worker Dockerfiles
- [ ] Write one skill for the `--for` lens
- [ ] Update `src/server/shipit-docs/` for the new agent-facing command
- [ ] Verify `ripwire --version` inside a built session container
