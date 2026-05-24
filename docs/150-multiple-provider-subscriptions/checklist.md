# 150 — Multiple provider subscriptions checklist

- [ ] Confirm provider account identity fields for Claude and Codex.
- [x] Add provider-account data model and migration from singleton credentials.
- [ ] Make Claude and Codex auth managers account-scoped.
- [x] Add provider account selection and status manager.
- [x] Persist `provider_account_id` on sessions.
- [x] Provision per-session credentials from the selected provider account.
- [x] Extend token sync-in/sync-back to account-qualified credential paths.
- [ ] Render provider account management in Settings.
- [ ] Render subscription limits by provider account.
- [ ] Skip exhausted accounts for new turns.
- [ ] Add conservative mid-turn failover with side-effect detection.
- [ ] Add server, integration, and client tests.
