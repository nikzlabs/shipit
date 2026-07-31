---
title: Keep preview running
description: Reserve a session runtime so an early-stage private preview stays available without a separate deployment.
---

# 241 — Keep preview running

## Goal

Let a user opt one session into an always-on preview inside ShipIt. Its session
container and `x-shipit-preview: auto` services remain available without an
attached viewer or agent turn, including after an orchestrator restart.

This is for prototypes that need a stable, private URL but do not yet justify a
deployment or application-level authentication.

## Requirement provenance

The requested experience is narrowly: “this preview should not randomly stop.”
It does not require changing what a sidebar pin means, introducing a general job
scheduler, or turning every Compose service into a deployment target.

## User experience

- A session overflow action toggles **Keep preview running**. The item shows a
  checkmark when enabled; there is no additional persistent-runtime status UI.
- Enabling starts the session and its auto-preview services immediately. Disabling
  returns it to ordinary idle cleanup; it does not stop it immediately.
- The preview remains behind ShipIt's existing access boundary. This feature does
  not make the app public and does not add application authentication.
- If ShipIt cannot honor the reservation (start failure, crash loop, or exhausted
  host capacity), it uses the existing session, service-error, and Logs surfaces
  to explain the failure rather than adding another status indicator.

## Design

Persist an explicit per-session `keepPreviewRunning` flag. Do not derive it from
`pinnedAt`: pins are unlimited and currently guarantee sidebar/workspace
persistence, while a runtime reservation consumes RAM and CPU continuously.

The flag affects three lifecycle paths:

1. **Idle enforcement:** `idle-enforcer.ts` excludes reserved sessions from the
   normal idle candidate set. The existing `agentBusy` and viewer protections
   remain unchanged for all sessions.
2. **Startup reconciliation:** after session/container rediscovery, the
   orchestrator activates every reserved session without a running container.
   Normal runner creation and Compose reconciliation then start services marked
   `x-shipit-preview: auto`; no second service-start mechanism is introduced.
3. **Unexpected exit:** a reserved session container that exits is recreated with
   bounded exponential backoff. After the retry budget is exhausted, its durable
   reservation remains enabled, but the failure is exposed through the existing
   session and service-error surfaces rather than looping forever.

The deployment config sets a maximum number of always-on previews (default: 1).
Enabling beyond that limit fails before mutating the session. Resource admission
uses the session's configured limit plus declared Compose-service limits where
available; the cap remains the hard safety boundary when Compose limits are not
declared.

Normal memory-pressure eviction must not select a reserved session, because that
would contradict the user-facing guarantee. If reserved workloads alone exceed
safe host capacity, ShipIt reports the capacity fault prominently and refuses new
reservations. An operator can still stop ShipIt or its containers explicitly.

## Data and API

- Add a persisted session flag. It survives restarts; actual container and service
  state continues to come from the existing Docker reconciliation paths.
- Add a session-scoped HTTP mutation for enabling/disabling the reservation and
  include its state in `SessionInfo`/the canonical session list.
- Keep preview URLs and proxy routing unchanged.

## Main touchpoints

- `src/server/shared/types/domain-types/session.ts` and `database.ts`
- `src/server/orchestrator/sessions.ts`, `idle-enforcer.ts`, and
  `app-lifecycle.ts`
- `src/server/orchestrator/session-container.ts` for bounded restart supervision
- Session API/service validation and the checked session-menu action
- Idle-enforcer, restart, startup-reconciliation, API, and client component tests

## Non-goals

- Replacing production hosting or providing public availability/SLA guarantees.
- Keeping all pinned sessions warm.
- Keeping arbitrary shell background processes alive; durable processes still
  belong in `docker-compose.yml`.
- Adding authentication to the previewed application itself.

## Verified existing guarantees

- `idle-enforcer.ts:createIdleEnforcer` is the normal and pressure-driven
  container eviction chokepoint.
- `app-lifecycle.ts:buildRunnerFactory` recreates a missing session container,
  and the existing Compose reconciliation starts auto-preview services.
- `docs/110-pinned-sessions/plan.md` explicitly defines pinning as data/list
  persistence, not an always-warm container guarantee.
