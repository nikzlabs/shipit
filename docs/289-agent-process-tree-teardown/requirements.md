# Agent process-tree teardown

1. When ShipIt terminates an agent CLI process — at the end of a turn, on interrupt escalation, or on runner dispose — everything that CLI spawned is terminated too, not only its own pid.
2. The guarantee holds regardless of how the third-party CLI behaves on its way out. It must not depend on the CLI tearing its own MCP servers down correctly.
3. The signal semantics the adapters rely on are unchanged: a path that sends SIGINT first so the CLI can flush keeps doing that, and the tree teardown sits behind the same escalation rather than replacing it with an immediate SIGKILL.
4. The sub-agent spawn path (`shared/sub-agent-run.ts`) behaves as before, apart from whatever it inherits from the shared helper.
5. Terminating a tree never signals a process ShipIt did not spawn. A pid that was reaped and recycled between being recorded and being signalled must not receive the signal, up to the limit of what a pid-based API can promise — see the plan's note on the residual window.

## Open questions

None.

## Resolved questions

- 2026-09-03 — Which mechanism: a process-group kill (`detached: true` + `kill(-pid)`) or a `/proc` descendant walk? Nik delegated the choice with a decision rule: use the group kill unless the CLIs or `playwright-mcp` put children in their own session or group. They do — `playwright-core`'s `launchProcess` spawns every browser with `detached: process.platform !== "win32"` (verified in `/opt/agent-cli/node_modules/playwright-core/lib/coreBundle.js`), so a browser is a session leader of its own and a group signal cannot reach it. The walk it is (req 1).
- 2026-09-03 — Should ShipIt chase the root cause in the third-party CLI? No. Nik: the leak could not be reproduced synthetically (SIGTERM, SIGKILL, stdin close, group signal and a direct browser signal each tore the browser down cleanly), the trigger lives in the CLI's own MCP teardown, and the fix here is a ShipIt-side guarantee that holds either way (req 2).
