# 097 — Explicit Session-Agent Permissions — Checklist

- [ ] Decide between Option A (baked-in image), B (host mount), or C (`--settings` CLI flag). See `plan.md` § "Design".
- [ ] Land `src/server/session/agent-settings.json` (or similar) with the recommended starting policy.
- [ ] Wire it into the chosen path (Dockerfile copy / `buildMounts()` / CLI flag in `claude.ts`).
- [ ] Add a `src/server/orchestrator/integration_tests/agent-permissions.test.ts` smoke test that asserts a denied operation actually fails — protects against schema drift.
- [ ] Verify existing session-worker integration tests still pass.
- [ ] Lint, typecheck, full suite.
- [ ] Mark `status: in-progress` when work begins; `done` when complete.

## Discussion items (resolve before implementation)

- Should `Bash(*)` stay broad, or should we deny common destructive patterns (`rm -rf /`, `git push --force`)? Probably keep broad and rely on git auto-commit to make destructive changes recoverable.
- Should `~/.claude/settings.json` be writable by the agent at all? Default deny seems right. If a session ever needs to escalate, expose a separate API rather than letting the agent self-modify.
- Symlink the dev-loop `.claude/settings.json` (feature 096) and the session-agent settings file? Pro: one source of truth. Con: they govern different agents with potentially different policies — easier to evolve independently.
