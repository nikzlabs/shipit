# Checklist — mutable sandbox capabilities

- [x] Sub-grant rule (`dangerousGitHubOps` requires `git`) moves into `normalizeCapabilities`
- [x] `SandboxCapabilitiesView` type + `capabilitiesPendingRestart` predicate
- [x] `SessionContainer.capabilitiesAtStart` recorded at container creation
- [x] `GET` / `PUT /api/sessions/:id/capabilities` (browser-only, sandbox-only)
- [x] `session_settings_change` card: type, WS message, column + migration, `toRow`/`fromRow`, `CARD_MESSAGE_FIELDS`, transcript scoping
- [x] Card emitted on a sandbox capability change
- [x] Card emitted on a regular session's network-mode change
- [x] `SandboxCapabilityToggles` extracted; `SandboxDialog` uses it
- [x] `SessionSettingsDialog` capabilities section + pending + restart
- [x] `SandboxBanner` opens the settings dialog; open-state in `ui-store`; dialog hoisted to `App`
- [x] `shipit-docs/sandbox-session.md` + docs/211 plan updated
- [x] Server tests: predicate, service (gating, sub-grant, no-op, card, pending), container snapshot, card round-trip
- [x] Client tests: dialog sandbox half, card render, handler scoping
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Independent review via `shipit agent run --role reviewer`

Not done, and deliberately out of scope:

- **No live browser pass.** The dogfood `dev` Compose service can't build on this
  host — `Dockerfile.dogfood`'s `install-agent-clis` step fails in `npm ci`,
  in files this branch does not touch. The dialog, card and handler are covered
  by component tests instead.
