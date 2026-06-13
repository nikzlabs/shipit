# Integrations tab — checklist

- [ ] Add `SettingsIntegrations.tsx` composing the two tiered sections
- [ ] Extract the GitHub connection block out of `Settings.tsx` into the integrations component
- [ ] Update `Settings.tsx` `Tab` union + `generalTabs` (drop github/trackers/mcp, add integrations) and `tabLabel`
- [ ] Add "Managed by ShipIt" badge on curated rows (security-model cue)
- [ ] Keep GitHub PR-automation toggle nested under the GitHub row
- [ ] Update tab tests referencing `settings-tab-github` / `-trackers` / `-mcp`
- [ ] Add a render test for `SettingsIntegrations` (both sections + badge present)
- [ ] Decide whether to keep deep links to old tab ids (grep for external references first)
