# 150 — Multiple provider subscriptions checklist

- [ ] Confirm provider account identity fields for Claude and Codex.
- [ ] Add provider-account data model and migration from singleton credentials.
- [ ] Make Claude and Codex auth managers account-scoped.
- [ ] Add provider account selection and status manager.
- [ ] Persist `provider_account_id` on sessions.
- [ ] Provision per-session credentials from the selected provider account.
- [ ] Extend token sync-in/sync-back to account-qualified credential paths.
- [ ] Render provider account management in Settings.
- [ ] Render subscription limits by provider account.
- [ ] Skip exhausted accounts for new turns.
- [ ] Add conservative mid-turn failover with side-effect detection.
- [ ] Add server, integration, and client tests.
