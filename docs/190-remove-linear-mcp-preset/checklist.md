# 190 — Remove the Linear MCP OAuth preset — checklist

- [x] Remove the `linear_oauth` entry from `MCP_OAUTH_PROVIDERS` and update its docstrings.
- [x] Update source docstrings (`mcp-types.ts`, `credential-store.ts`, `mcp-resolve.ts`) to use Notion as the example.
- [x] Migrate registry-coupled OAuth tests to Notion's DCR/discovery flow
      (`services/mcp-oauth.test.ts`, `integration_tests/mcp-oauth-routes.test.ts`,
      `integration_tests/mcp-routes.test.ts`, `app-lifecycle.test.ts`).
- [x] Purge `linear_oauth` / `MCP_PLATFORM_LINEAR_OAUTH` from registry-independent
      fixtures (`credential-store.test.ts`, `secret-resolver.test.ts`,
      `agent-env-push.test.ts`, `mcp-resolve.test.ts`, client `mcp-store.test.ts`,
      `McpServerSettings.test.tsx`).
- [x] Update docs (`docs/088` status banner, this doc) and `shipit-docs/secrets.md`.
- [x] `npm run typecheck` clean.
- [x] `npm run lint:dev` clean.
- [x] Affected MCP test files pass (200 server + 28 client).
- [ ] Open PR.
