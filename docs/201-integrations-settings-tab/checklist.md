# Integrations tab — checklist

- [x] Add `SettingsIntegrations.tsx` composing the two tiered sections
- [x] Extract the GitHub connection block out of `Settings.tsx` into the integrations component
- [x] Update `Settings.tsx` `Tab` union + `generalTabs` (drop github/trackers/mcp, add integrations) and `tabLabel`
- [x] Add "Managed by ShipIt" badge on curated rows (security-model cue) — shared `ManagedByShipItBadge.tsx`
- [x] Keep GitHub PR-automation toggle nested under the GitHub row
- [x] Add `embedded` mode to `SettingsTrackers` and `McpServerSettings` (parent owns scroll container + section header)
- [x] Update `ui-store` `SettingsTab` union + deep links (`useServerEvents`, `PrLifecycleCard`, `App.handleSettingsOpen`) from github/trackers → integrations
- [x] Update tab tests referencing the old GitHub/Trackers/MCP tab names
- [x] Add a render test for `SettingsIntegrations` (both sections + badge + GitHub states)
- [ ] Optional follow-up: convert the Linear connected state to the same compact logo-row as GitHub (visual parity; deferred in v1)
- [ ] Optional follow-up: decide whether GitHub PR-automation toggle stays nested or moves to Advanced
