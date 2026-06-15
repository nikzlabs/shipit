---
issue: https://linear.app/shipit-ai/issue/SHI-130
title: Integrations settings tab
description: Consolidate GitHub, issue trackers (Linear), and MCP servers into one tiered "Integrations" settings tab.
---

# Integrations settings tab

**Visual reference:** [mockup.html](./mockup.html) — the proposed tiered layout (Connected services on top, MCP servers below).

## Problem

ShipIt's "connect an external service" surface is split across three settings tabs that
don't acknowledge each other:

- **GitHub** — auto-connected via account auth (`Settings.tsx` lines ~1541–1587 + `GitHubTokenForm.tsx`).
- **Trackers** — Linear, connected with a personal API token and a team picker (`SettingsTrackers.tsx`, docs/170).
- **MCP Servers** — user-supplied tool extensions, plus one-click OAuth providers (`McpServerSettings.tsx`, docs/088).

The MCP tab is where users instinctively look for "connect a service." Linear support is
real and first-class, but it lives in a separate **Trackers** tab that a user scanning the
MCP list never sees. The failure mode is concrete and we have already hit it once: users go
hunting for a Linear MCP server to wire up manually. That path actively fights the
architecture — Linear is deliberately brokered through `shipit issue` so the tracker token
**never enters the session container**. Connecting Linear as a raw MCP server bypasses that
brokering and puts a credential in the box.

docs/190 already removed Linear as a built-in one-click MCP OAuth provider for exactly this
reason (see the comment in `mcp-oauth-providers.ts`). That fixed the *duplicate connect
button*, but not the *discoverability gap*: there is still nothing in or near the MCP tab
that tells a user "Linear connects over here, and it connects differently." This doc closes
that gap at the information-architecture level.

## Proposal

Replace the three tabs (`github`, `trackers`, `mcp`) with a single **Integrations** tab that
is internally **tiered** into two clearly-distinct sections. The tiering is the whole point —
a flat list would trade one confusion for another (users would think they can add any service
as a curated integration, or that they can remove GitHub like an MCP entry).

### Section 1 — Connected services (curated / first-party)

ShipIt-owned capabilities: brokered credentials, deep inline rendering (PR cards, issue
cards), curated set. Each row shows a connection state and a small **"Managed by ShipIt"**
affordance signalling that credentials are brokered out of the container — the visible cue
for the security-model difference.

Each integration is **one self-contained card** (`bg-secondary`, soft border, rounded): a
header carries the logo tile, name, "Managed by ShipIt" badge, and the integration's action
buttons in a **consistent top-right slot**; the integration's own settings/state live **inside
the same card** below a `border-secondary` divider — never as a separate floating card. This
keeps "the integration" and "its related settings" visually grouped (a single source of edge),
and puts Disconnect in the same place for every service.

- **GitHub** — auto-"Connected" with username/avatar when account auth is present (token form
  via `GitHubTokenForm` otherwise). The GitHub-specific PR-automation toggle (`PullRequestSettings`,
  "Auto-create PR after every meaningful turn") renders **inside the GitHub card** below the
  header divider — a GitHub-scoped behavior, visually owned by GitHub rather than floating as
  its own nested card.
- **Linear** — the existing `SettingsTrackers` flow (paste token → pick team → Connected →
  Change team / Disconnect), restructured into the same single-card shape. **Disconnect** (an
  integration-level action) sits top-right in the header, matching GitHub. **Change team** is
  team-scoped, so it renders on the connected team's own line in the detail below the divider —
  next to what it acts on, not floated far up in the header. The team picker / token form render
  in that same below-divider region.
- **Future** — additional first-party integrations (Jira, Sentry, …) are added to this curated
  list, not exposed as "add your own." (The standing "More first-party integrations… land here"
  caption was removed — it described an empty future state and added noise.)

### Section 2 — MCP servers (custom / advanced)

The existing `McpServerSettings` content unchanged in behavior, reframed with a one-line intro:
"Extend the agent with your own tools via the Model Context Protocol." Contains the OAuth
provider cards (Notion, …), manual stdio/HTTP server config, and per-server runtime status.

This is where the mechanism is generic and user-supplied. It sits **below** the curated
section so the visual hierarchy reads "here are the things ShipIt manages for you; below,
bring your own."

## Design decisions

1. **Tier, don't flatten.** Two sections in one tab, not one merged list. The mechanisms differ
   (curated capability vs. generic protocol) and — load-bearing — the **security models differ**:
   curated integrations broker credentials out of the session container; MCP servers may carry
   credentials into it. The UI must *signal* that difference (the "Managed by ShipIt" badge),
   not hide it.
2. **GitHub connection lives in Integrations; GitHub PR-automation behavior stays adjacent to it.**
   We do not scatter GitHub across two tabs. Connection + disconnect + the PR-automation toggle
   all sit under the GitHub row.
3. **Do not offer Linear as an addable MCP.** Already true post-docs/190; the Integrations tab
   reinforces it structurally. (We are deliberately *not* adding an empty-state "looking for
   Linear? connect above" redirect in the MCP section — the tiered single tab makes the right
   path the obvious one without a signpost.)
4. **Name it "Integrations."** Reads more first-class than "Connections" and scales to future
   first-party services without tab sprawl.

## Trade-offs / risks

- **Conflation risk** if the tiering is weak — mitigated by distinct section headers, the
  "Managed by ShipIt" badge on curated rows, and visual separation.
- **A longer single tab.** Three tabs' content stacks vertically. Acceptable: the curated
  section is short (2 rows today), and the tab scrolls. If it grows, the curated section can
  collapse connected rows to a compact "Connected" summary.
- **Tab width.** The MCP form is the widest content of the three; the merged tab keeps the
  existing `max-w-2xl` dialog width (the Skills tab is the only `max-w-5xl` exception and is
  unaffected).

## Implementation (shipped)

A new container component composes the three existing pieces; the underlying connection logic
and stores are reused as-is. It is an information-architecture change, not a data-model one — no
store shape changed.

- **New `src/client/components/SettingsIntegrations.tsx`** — owns the single scroll container and
  the two `SectionHeader`s. Renders `GitHubConnectionCard` (the GitHub block extracted from
  `Settings.tsx`, with its double-click-confirm Disconnect and the `PullRequestSettings` toggle
  moved in), `SettingsTrackers`, and `McpServerSettings`. Holds a local `LinearLogo` brand glyph
  (the sanctioned exception to "no hardcoded SVG" — Phosphor has no Linear mark).
- **New `src/client/components/ManagedByShipItBadge.tsx`** — the shared shield badge
  (`ShieldCheckIcon` + "Managed by ShipIt") used on each curated row to signal credential
  brokering. Imported by both `SettingsIntegrations` and `SettingsTrackers`.
- **`SettingsTrackers` / `McpServerSettings`** — gained an `embedded?: boolean` prop. When
  embedded, they drop their own `px-5 py-4 … overflow h-full` scroll wrapper (the parent owns it)
  and their redundant top heading; `SettingsTrackers` additionally renders a `logo` slot + the
  badge next to "Linear".
- **`Settings.tsx`** — `Tab` union + `generalTabs` drop `github | trackers | mcp`, add
  `integrations`; `tabLabel` → "Integrations"; the three `TabsContent` blocks collapse to one.
  `PullRequestSettings` and the GitHub `confirmingLogout`/`disconnecting` state moved out.
- **Deep-link updates** — `ui-store`'s `SettingsTab` union, plus `useServerEvents` (invalid-token
  toast), `PrLifecycleCard` (PR auth CTA), and `App.handleSettingsOpen` (Issues "Connect" CTA) now
  target `integrations` instead of `github`/`trackers`.
- **Tests** — `Settings.test.tsx` tab navigation updated to the "Integrations" tab name (test ids
  like `settings-disconnect` / `github-token-form` preserved, so the GitHub assertions are
  unchanged). New `SettingsIntegrations.test.tsx` asserts both tiers render, the badge appears on
  curated rows, and the GitHub connected/disconnected states + PR toggle work.

## Alignment with product principles

This change is squarely on-principle (CLAUDE.md §1/§2): GitHub and Linear are
inline-rendered, ShipIt-owned capabilities, and presenting them as first-class **Integrations**
— rather than as "go configure an MCP" — reinforces that ShipIt owns the surface instead of
nudging the user toward a generic, less-safe, out-of-container path.

## Key files

- `src/client/components/SettingsIntegrations.tsx` — **new**; the tiered tab container + GitHub
  card + PR toggle + Linear logo.
- `src/client/components/ManagedByShipItBadge.tsx` — **new**; shared "Managed by ShipIt" shield.
- `src/client/components/Settings.tsx` — tab list, labels, content host (three tabs → one).
- `src/client/components/SettingsTrackers.tsx` — Linear connection flow (docs/170); gained
  `embedded` + `logo`.
- `src/client/components/McpServerSettings.tsx` — MCP CRUD + OAuth cards (docs/088); gained
  `embedded`.
- `src/client/components/GitHubTokenForm.tsx` — GitHub token entry (reused).
- `src/client/stores/ui-store.ts` — `SettingsTab` union.
- `src/server/orchestrator/mcp-oauth-providers.ts` — OAuth provider registry; documents the
  docs/190 Linear removal that this tab builds on.
- `src/client/stores/{settings,issues,mcp}-store.ts` — reused unchanged.

## Related docs

- docs/088-mcp-integration — MCP servers + OAuth providers.
- docs/170-inline-tracker-issues — native Linear integration (`shipit issue`, inline cards).
- docs/190-remove-linear-mcp-preset — removed the duplicate Linear MCP OAuth button; this doc
  closes the remaining discoverability gap.
