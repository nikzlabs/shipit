# 149 — shipit-review MCP permission bug

- [x] Add `mcp__shipit-review__*` to `AUTO_TOOLS` / `PLAN_TOOLS` in
      `src/server/session/claude.ts` (both `ClaudeProcess.run` and
      `StreamingClaudeProcess.run`).
- [x] Pin the allowlist entry with a parameterized test in
      `src/server/session/claude.test.ts` covering `auto`, `plan`,
      and `guarded` modes.
- [x] Note the root cause and fix in `plan.md` so the misleading
      "two gates" framing in the original report doesn't bite again.
