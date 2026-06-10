---
issue: https://linear.app/shipit-ai/issue/SHI-104
description: Remove Linear as a built-in one-click MCP OAuth provider; Notion becomes the sole seeded provider, Linear stays connectable manually.
---

# 190 — Remove the Linear MCP OAuth preset

## Summary

ShipIt shipped **two** ways to use Linear, and they overlapped confusingly:

1. **Native Linear issue tracker** (docs/170, docs/156) — a personal API key under
   Settings → **Issues**, the tracker-neutral `shipit issue` command, and inline
   issue rendering (Issues tab, `IssueDetail`, provenance cards). This is the
   sanctioned, ShipIt-shaped path.
2. **Linear as a built-in one-click MCP OAuth provider** (docs/088 Phase 2) — a
   branded "Connect with Linear" button under Settings → **MCP Servers** that ran
   an OAuth 2.1 flow and handed the agent raw `linear_*` MCP tools.

Two "Connect Linear" buttons, two separate credentials, two mental models for the
same external system. This doc removes path (2)'s **branded preset** while keeping
the generic MCP infrastructure intact.

## Decision

Delete the `linear_oauth` entry from the `MCP_OAUTH_PROVIDERS` registry
(`mcp-oauth-providers.ts`). That is the whole of the user-visible change:

- The "Connect with Linear" one-click button disappears (the Settings UI renders
  whatever the registry returns — no component change needed).
- **Notion remains the sole seeded OAuth provider.** The OAuth framework, the
  generic "add any MCP server" form, and the `$platform:` / `MCP_PLATFORM_*`
  plumbing all stay.
- **Linear-as-MCP is still reachable manually**: Settings → MCP Servers → add an
  HTTP server at `https://mcp.linear.app/mcp` (or the stdio `@anthropic-ai/linear-mcp`
  package). It's no longer a first-class button, which is the point — it's an
  advanced, opt-in path rather than a peer of the native tracker.

### Why hard-remove (no migration)

ShipIt has no production users beyond the author, so any already-connected
`linear_oauth` tokens are not a concern. The entry is deleted outright rather than
hidden-but-honored; stale tokens (if any) simply become inert.

### Rationale (why this is the right call, not just a cleanup)

- **Product principle §1/§2 (CLAUDE.md):** the native tracker renders issues
  *inline* and is tracker-neutral across Linear + GitHub. The MCP path gives the
  agent tools that render nothing inside ShipIt. The inline path is the better fit.
- **The repo already picked a side:** `CLAUDE.md` instructs the agent to use
  `shipit issue` and explicitly *not* "a Linear MCP". A branded preset steering
  users toward the path the repo steers the agent away from is a mixed message.
- **Surgical:** Linear was one of two registry presets (Notion is the other), so
  removing it leaves the OAuth framework and Notion untouched.

## Scope of changes

- **`src/server/orchestrator/mcp-oauth-providers.ts`** — remove the `linear_oauth`
  entry; update module docstrings to use Notion as the example.
- **Docstrings** referencing `linear_oauth` / `MCP_PLATFORM_LINEAR_OAUTH` as the
  example source (`mcp-types.ts`, `credential-store.ts`, `mcp-resolve.ts`) →
  Notion.
- **Tests** — the OAuth test suite used Linear as its canonical
  *no-DCR / operator-env-required* fixture and as a second provider. Migrated:
  - Registry-coupled suites (`services/mcp-oauth.test.ts`,
    `integration_tests/mcp-oauth-routes.test.ts`, the refresh-route test in
    `integration_tests/mcp-routes.test.ts`, `app-lifecycle.test.ts`) → Notion's
    DCR/discovery flow.
  - Registry-independent fixtures (`credential-store.test.ts`,
    `secret-resolver.test.ts`, `agent-env-push.test.ts`, `mcp-resolve.test.ts`,
    client `mcp-store.test.ts` / `McpServerSettings.test.tsx`) → `notion_oauth`,
    with `sentry_oauth` as the illustrative second source where a test genuinely
    needs two distinct providers.
- **Docs** — status banner on `docs/088`, this doc, and a `shipit-docs/secrets.md`
  wording tweak.
- **Kept untouched:** the native Linear *tracker* (docs/170 — `LinearTracker`,
  `getLinearToken`, Issues tab) and all *manual* Linear MCP config examples
  (`mcp__linear__*`, `@anthropic-ai/linear-mcp`, server name `linear`).

## A note on dormant coverage

Linear was the only seeded provider without RFC 7591 dynamic client registration,
so it was the fixture that exercised the "no DCR → operator must set
`<ID>_OAUTH_CLIENT_ID` → 400 if unset" branch in `startOAuthFlow`. That branch
still exists for a future no-DCR provider, but with Linear gone no seeded provider
exercises it, so its dedicated tests were dropped. If a no-DCR provider is added
later, restore a fixture for that path.

## Key files

- `src/server/orchestrator/mcp-oauth-providers.ts` — the registry (the actual removal).
- `src/server/orchestrator/services/mcp-oauth.ts` — OAuth flow (unchanged; the
  no-DCR/env-required branch is retained but now unexercised by a seeded provider).
- `src/client/components/McpServerSettings.tsx` — generic provider rendering (unchanged).
