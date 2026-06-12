# Checklist — docs/199 MCP bridge precompile

- [x] Root-cause the failure mechanism (CLI 2000ms pre-wait + lazy permission-tool lookup → exit 1; tsx esbuild compile is the CPU cost)
- [x] Confirm CPU (not memory) is the binding constraint (oom_kill=0; contention proxy)
- [x] `scripts/build-mcp-bridges.mjs` — esbuild self-contained bundles to `dist/mcp-bridges/`
- [x] `build:bridges` npm script + pinned `esbuild` devDependency (passes check-deps)
- [x] `resolveBridge()` — compiled-JS-first with tsx fallback; worker delegates to it
- [x] Dockerfile.session-worker.prod — build before prune, copy `dist/mcp-bridges`
- [x] Tests: resolution order + end-to-end self-contained bundle spawn
- [x] test:dev / lint / typecheck green
- [ ] Operator: validate on `pnpm-canary-183` / `py-canary-183` / OPS at default limits after image ships
- [x] Follow-up (SHI-128): consolidate the bridges into ONE `shipit` stdio process serving all tools (cuts process count 5→1 and memory ~138MB→~30MB). Per-agent tool subset via `SHIPIT_MCP_TOOLS`; tool names now `mcp__shipit__<tool>`. See plan.md "Consolidation into one process (SHI-128)".
