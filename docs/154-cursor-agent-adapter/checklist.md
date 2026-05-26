# Cursor Agent adapter checklist

- [ ] Add admin-selected agent CLI install config to production setup.
- [ ] Add pinned Cursor CLI entry to the agent CLI version manifest.
- [ ] Add Docker build args and installer support for optional Cursor install.
- [ ] Write `/opt/shipit/agents/installed.json` during image build.
- [ ] Add `cursor` to `AgentId` and audit two-agent assumptions.
- [ ] Add `CURSOR_API_KEY` to the allowed agent env keys.
- [ ] Add Cursor install/auth detection to `AgentRegistry`.
- [ ] Update client agent selector, local storage validation, and auth settings.
- [ ] Implement `CursorAdapter` using `cursor-agent -p --output-format stream-json`.
- [ ] Add unit tests for Cursor stream parsing and process lifecycle behavior.
- [ ] Add session/orchestrator integration coverage with a fake Cursor process.
- [ ] Add a real Cursor CLI contract test gated on the approved version.
- [ ] Verify prompt delivery, model ids, resume behavior, and MCP config support against the pinned CLI.
