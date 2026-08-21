---
issue: planning#469
title: Mutable sandbox capabilities
description: How a sandbox session's capability grants become editable after creation — the durable write, what applies live vs. pends a container restart, and the persisted transcript card that also covers a regular session's network-mode change.
---

# Mutable sandbox capabilities

Implements [requirements.md](requirements.md). Requirements are cited as `(req N)`.

## Problem

`capabilities` is written once by `createSandboxSession` and never again
(docs/211-sandbox-sessions). `SandboxDialog` is the only writer, `setCapabilities`
has exactly one non-test caller, and every doc comment on the path says
"immutable". Changing a grant means discarding the session.

## Which capability applies live, and which needs a restart

This is not a policy choice — it follows from **where each grant is read**, and
it is what req 2 and req 3 partition on:

| Capability | Read at | Applies |
|---|---|---|
| `git` | `gitCredentialAllowed` (`pr-target.ts`), per request | **live** |
| `dangerousGitHubOps` | `prMergeAllowed` (`pr-target.ts`), per request | **live** |
| `docker` | `buildConfigForWorkspace({ dockerAccess })` → `DOCKER_HOST` + the session bridge network, at container creation | **restart** |
| `network` | `sandboxLifelineEgressConfig` → the Tier A/B/C egress topology installed into the netns at container creation | **restart** |
| `git`, when `network` is off | *also* `sandboxLifelineBase({ git })` — whether `github.com` is in the lifeline allowlist, likewise plumbed at creation | **restart** |

So the two orchestrator-side brokers need nothing but the durable write, and the
two container-plumbed grants get the egress dialog's pending treatment (req 3).

The last row is the non-obvious one. A network-off sandbox's lifeline base
includes `github.com` only when `git` is granted, so flipping `git` there changes
the container's egress topology even though `git` itself is otherwise live. It is
folded into the pending predicate rather than driven through `reloadEgress`: a
live reload REMOVES the resolver and proxy before launching replacements and
throws if the launch fails, leaving the agent with no DNS — a new failure path,
against a restart the user can already click. `pendingRestart` also stays purely
*derived* that way, with no best-effort outcome to report.

## What the live container started with

`pendingRestart` is a diff, so something has to hold the other side of it. The
egress dialog reads `SessionContainer.egressContainedAtStart`, and that field
cannot answer this question: a network-off sandbox and a network-on one both
resolve to `contained: true`, so the flag is identical across the change while
the *base allowlist* is completely different.

So the container record grows `capabilitiesAtStart`, recorded in
`createContainerForRunner` (`app-lifecycle.ts`) at the same point it derives
`sandboxDockerAccess` from the same `opts.session.capabilities` — the place the
grant becomes container plumbing. It follows `egressContainedAtStart`'s
convention exactly: **absent means unknown**, which is the state of a
rediscovered / re-adopted container after an orchestrator restart, and unknown
reports no pending diff rather than a false one.

```ts
// orchestrator/sandbox-capabilities.ts
capabilitiesPendingRestart(started, current) =>
  !!started && (started.docker !== current.docker
             || started.network !== current.network
             || (!current.network && started.git !== current.git))
```

## The write path

`PUT /api/sessions/:id/capabilities` (`api-routes-session-crud.ts`), with a
sibling `GET` for the dialog's initial read.

- **Browser-only.** No `containerAccessible` flag, the same way the egress
  routes are registered — that, not any check inside the container, is what keeps
  req 4's "an agent cannot self-elevate" true once the set is writable.
- **Sandbox-only.** 400 for a session whose `kind !== "sandbox"`: an ordinary or
  ops session has no capability set, and inventing one would be a second,
  undeclared way into privileged wiring.
- **`normalizeCapabilities` gains the sub-grant rule** — `dangerousGitHubOps` is
  cleared whenever `git` is off. It was enforced only in `SandboxDialog`'s local
  state, i.e. client-side, on the one payload the server explicitly does not
  trust. It belongs in the coercer both trust boundaries already run through.
- Persists via the existing `setCapabilities`, then broadcasts `session_updated`
  over SSE so the sidebar badge and the sandbox banner track it without a reload.

The response is a `SandboxCapabilitiesView` — the normalized set, what the live
container started with, and the derived `pendingRestart` — mirroring
`EgressSessionSettings`, so the dialog renders the pending row from a server
answer instead of re-deriving one.

Restart itself reuses `POST /api/sessions/:id/container/restart`, unchanged: the
dialog's existing "Restart to apply now" button already drives it, is refused
while a turn is running, and is never automatic (req 3).

A revoke writes the grant and nothing else (req 6). Containers, networks and
volumes the agent created under a since-revoked Docker grant are labelled to the
session and reaped on archive/teardown as they are today; a settings toggle
destroys nothing.

## The transcript card

`sessionSettingsChange` is a persisted card (req 7) covering both writers:

- a sandbox capability change, and
- a regular session's network-mode change from the same dialog (req 8), which is
  silent today — emitted from the `PUT /api/egress/session/:id` route.

One card type rather than two, because the two changes answer the same question
("what was this session allowed to do, and when did that change?") and the
transcript reads better with one shape. It carries the changed entries only
(label + from/to), the scope, and whether the change is pending a restart.

Written through `emitChatCard` (`chat-card-persistence.ts`), which emits,
records in-band at its true transcript position, and persists in one call —
and picks the post-turn `append` path itself when no turn is running. When the
session has no runner at all the card is appended directly to chat history
rather than dropped: the durable record is the point of req 7, and "nobody is
attached right now" is the case it most needs to survive.

Full card checklist per CLAUDE.md: typed field on `PersistedMessage` + a
`session_settings_change` column and migration, `toRow`/`fromRow`, rehydration,
`CARD_MESSAGE_FIELDS` registration, `sessionId` on the WS type +
`TRANSCRIPT_SCOPED_MESSAGES`, and the history round-trip guards.

## UI

- **`SandboxCapabilityToggles`** — `ToggleRow` / `SubToggleRow` and the four
  capability descriptions move out of `SandboxDialog` into one component used by
  both the creation dialog and the settings dialog, so the two can never describe
  the same grant differently.
- **`SessionSettingsDialog`** gains a Capabilities section for a sandbox, above
  the existing network-mode radio group, with its own pending row + "Restart to
  apply now" (req 5). Network access is a sandbox capability, so for a sandbox
  the egress radio group is not shown — two controls over one session's egress in
  one dialog would be a second source of truth.
- **`SandboxBanner`**'s granted list becomes the second entry point into that
  dialog (req 5). Its open-state moves to `ui-store` (alongside
  `sandboxDialogOpen`) and the dialog is rendered at `App` level, so the banner
  can open it whether or not the sidebar is mounted — on mobile the sidebar is a
  drawer, so leaving it inside `SessionItem` would make the banner's control dead
  on a phone.

## Key files

- `orchestrator/sandbox-capabilities.ts` (new) — the pending predicate + change
  description, the one place both routes read.
- `orchestrator/services/sandbox-capabilities-service.ts` (new) — the write.
- `orchestrator/api-routes-session-crud.ts` — `GET`/`PUT .../capabilities`.
- `orchestrator/api-routes-egress.ts` — the card on a network-mode change.
- `orchestrator/session-container.ts`, `orchestrator/app-lifecycle.ts` —
  `capabilitiesAtStart`.
- `shared/types/domain-types/session.ts` — sub-grant rule in the coercer,
  `SandboxCapabilitiesView`.
- `shared/types/domain-types/chat.ts`, `shared/types/ws-server-messages/cards.ts`,
  `shared/database.ts`, `orchestrator/chat-history.ts` — the card.
- `client/components/SandboxCapabilityToggles.tsx` (new),
  `SandboxDialog.tsx`, `SandboxBanner.tsx`,
  `SessionSidebar/SessionSettingsDialog.tsx`, `SessionSettingsChangeCard.tsx`
  (new), `stores/ui-store.ts`, `App.tsx`.
- `shipit-docs/sandbox-session.md` — the in-container contract no longer says
  the grants are fixed at creation.
