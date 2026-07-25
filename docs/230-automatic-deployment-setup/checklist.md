# Implementation checklist

## Phase 1 — Vercel setup for new repositories

- [ ] Define provider connection, deployment setup, and persisted state types.
- [ ] Add provider OAuth capability/configuration and encrypted credential storage.
- [ ] Add Vercel account/team discovery and idempotent Git-linked project creation.
- [ ] Add explicit deployment defaults to supported frontend templates.
- [ ] Extend repository creation with the optional deployment setup request.
- [ ] Add the deployment option and provider settings to `NewRepoDialog`.
- [ ] Persist and resume setup independently of WebSocket and session-container lifecycle.
- [ ] Render setup progress, actionable errors, and first deployment inline.
- [ ] Add adapter, service, integration, and client tests.
- [ ] Update agent-facing deployment documentation.

## Phase 2 — existing repositories

- [ ] Replace the Project Settings link list with the reusable inline setup flow.
- [ ] Detect build settings for existing repositories with confidence levels.
- [ ] Support retry, reconnect, reconfigure, and externally-connected states.
- [ ] Verify reload and orchestrator-restart recovery.

## Phase 3 — Cloudflare Pages

- [ ] Implement Cloudflare account discovery and GitHub installation validation.
- [ ] Add an idempotent Cloudflare Pages provider adapter.
- [ ] Add provider-specific configuration and failure tests.
- [ ] Enable Cloudflare Pages in repository creation and Project Settings.
