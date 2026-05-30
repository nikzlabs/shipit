---
status: planned
priority: medium
description: Special session type letting operators debug the production ShipIt host (stuck containers, OOM, Docker state) without leaving the ShipIt UI.
---

# Ops session — debug the prod ShipIt host from inside the prod ShipIt UI

## Problem

When something goes wrong on a production ShipIt host — a session
container in a SIGTERM/recreate loop, a stuck Docker daemon, a
runaway compose stack, an OOM-killed npm install — the operator's
only debug surface today is **SSH into the host** and run `docker
ps`, `journalctl`, `dmesg`, `docker logs`, etc. by hand.

That violates ShipIt's §1 principle ("ShipIt is the surface. The
user does not leave it.") in the worst possible place: the moment
ShipIt itself misbehaves. The operator opens a terminal tab,
reconstructs a multi-command investigation from memory or scrollback,
and works outside the very tool they spent the day building.

Two adjacent ideas have come up:

- **Add Portainer to the deployment.** Rejected — it's a separate UI
  for `docker ps`/`docker logs`/`docker stats`, which the orchestrator
  already has richer signals for (per-session log ring, diagnostics
  endpoint, container health monitor). Doesn't help with the
  cross-system correlation that real debugging needs.
- **Let an agent run on the host directly.** Rejected as too risky.
  Putting Claude on the host means giving it the Docker socket, all
  session containers, the credential store, and operator-level
  filesystem access. Inverts ShipIt's sandbox-first architecture, and
  needs an operator-only auth gate plus a command allow-list to be
  remotely safe.

This doc proposes the **middle ground**: a dedicated session inside
the production ShipIt where the agent has read-only access to the
Docker socket and the host's systemd journal. The agent stays in its
container (existing architecture), but it can run the investigation
prompts we already have ("show all session containers, grep journal
for `LOOP DETECTED` in the last hour, cross-reference docker events")
without the operator ever leaving the ShipIt tab.

## Design

### The session

One specially-configured session per prod host, owned by the operator.
Behaviourally, it's a normal ShipIt session — chat input, file tree,
preview, terminal — but its container has additional mounts and
environment that turn it into an "ops cockpit."

The session is **not auto-created**. The operator creates it
deliberately the first time the host is provisioned, with a known
session ID (or label) so they can find it after a restart. It lives
under a designated "ops" repo (essentially a workspace dir with a
README explaining the available commands and a `shipit.yaml` that
declares the privileged mounts).

### What goes in the container

| Mount / env | Purpose | Risk surface |
|---|---|---|
| `/var/run/docker.sock` (read-only) | `docker ps`, `docker logs`, `docker inspect`, `docker events`, `docker stats` | Read access only — agent can observe but not stop/rm/exec |
| `/var/log/journal` (read-only) | `journalctl --since`, grep for `LOOP DETECTED`, `[container]`, dispose stack traces | Read access only |
| `/run/log/journal` (read-only, fallback) | Volatile journal when `/var/log/journal` isn't persistent | Read access only |
| `DOCKER_HOST` env (unset) / use socket directly | Standard docker CLI path | — |
| `/var/lib/docker` — **NOT mounted** | Avoid leaking container layer data, secrets in env files, etc. | — |
| Other host paths — **NOT mounted** | `/etc`, `/root`, `/home`, etc. stay out | — |

The agent's container itself runs with the same resource limits as
any session container (1.5 GB RAM, 0.5 CPU, no Docker access via the
proxy). The privilege escalation is **only** the read-only socket
and journal — not Docker socket write access, not docker-proxy
elevation, not capability grants.

### Read-only socket — how

Docker's socket is fundamentally read-write — any process with write
access to `/var/run/docker.sock` can do anything to the daemon. So
"read-only mount" alone isn't enough; the agent can still `docker
stop`, `docker rm`, `docker exec --privileged` arbitrary containers.

Two options:

1. **Sidecar read-only proxy.** Run a small reverse-proxy container
   (e.g., [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
   that intercepts the Docker API and rejects mutating endpoints
   (`POST /containers/.../stop`, `POST /containers/.../kill`, etc.).
   The ops session mounts the proxy's socket, not the real one.
   Battle-tested approach; recommended.

2. **Group-restricted access + agent rule.** Mount the real socket
   but rely on the agent's prompt to not call mutating commands.
   Fragile. Skip.

Pick (1). The proxy is a 20-line `docker-compose` service we can
build into the ops session's `shipit.yaml` so it starts alongside
the agent container — same lifecycle, isolated network, no extra
operational burden.

### Workspace contents

The ops session's workspace is bootstrapped with:

```
ops/
  README.md            — short doc of what the agent can do here
  shipit.yaml          — declares the docker-socket-proxy compose service
  docker-compose.yml   — defines the proxy + agent-side env wiring
  prompts/
    investigate-loop.md      — the LOOP DETECTED post-hoc grep recipe
    diagnose-stuck-session.md — the f25c69f7-style investigation prompt
    daily-health.md           — daily host health snapshot
```

The `prompts/` files are reusable investigation recipes — copy/paste
into chat instead of reconstructing from memory. They are the same
prompts we've been refining manually in chat over the past few
sessions.

### Auth gate

The ops session must be reachable only by the operator. Options:

- **Same auth as the rest of ShipIt** — operator already has a login
  for ShipIt itself, ops session is just one of their sessions.
  Acceptable when ShipIt is single-tenant per host (one user owns the
  host).
- **Separate "ops" role** in `credentials.json` / settings — required
  if the host is multi-tenant (multiple subscribers share it). Out
  of scope for v1; defer until multi-tenant is real.

V1 ships with "same auth" — host operator == ShipIt user.

### Surfacing in the UI

The ops session is a genuinely different kind of session, not a
normal repo-backed one, so the UI treats it as its own thing rather
than blending it into the list. Three decisions:

**1. Created from Settings, not from a phantom list card.** Before
the ops session exists there is nothing to render in the sidebar, so
a placeholder card would just be confusing. The create affordance
lives in a gated **"Ops / Host"** section in Settings
(`Settings.tsx`) — a short explanation plus a single "Create ops
session for this host" button. This is also the natural home for the
operator gate (the button is only shown/enabled for the host
operator; see "Auth gate"). Creation calls the
`POST /api/sessions/from-template` route with `template: "ops"`
(implementation step 2).

**2. Rendered in its own dedicated sidebar group once it exists.**
An ops session has no normal `remoteUrl`, so today it would already
fall into `SessionSidebar.tsx`'s `OrphanSessionGroup` ("Other
sessions"). Instead of letting it blend in, we render it in a
distinct, pinned **"Host / Ops"** group (its own labeled group,
separate from repo groups and the local/orphan groups), keyed off
`kind: "ops"`. The card keeps a subtle "ops" badge and the default
title `Ops — {hostname}` so it's self-describing.

**3. A different right-panel tab set.** Not all of the usual tabs are
meaningful for an ops session, and the host signals we *do* want
aren't surfaced by any existing tab. Right-panel tabs are already
conditional per-session (`RightTab` union in `ui-store.ts`; App.tsx
hides Preview/Terminal in local mode, Services unless compose
services exist, PR unless a PR exists), so a per-kind tab set is the
established pattern, not a new mechanism. For `kind: "ops"`:

| Tab | Ops session | Why |
|---|---|---|
| Preview | **hidden** | No app preview to render |
| PR | **hidden** | Ops session has no PR / merge lifecycle |
| Files | keep | The `ops/` workspace + `prompts/` |
| Terminal | keep | Legit ad-hoc escape hatch (§5) |
| History | keep | Chat history doubles as the incident log |
| Services | keep (conditional) | The `docker-socket-proxy` compose service |
| **Host** | **new** | Read-only inline view of host/Docker signals |

**The new "Host" tab** renders, read-only and inline, the signals
the orchestrator already collects (and which the "reject Portainer"
argument in the Problem section leans on): the list of session
containers with status + health, per-session log-ring tails, the
container-health monitor's current verdicts, and a `docker events` /
journal tail. This is informational rendering in the spirit of §1/§2
(same shape as the PR card or Services tab) — **not** a control
surface. It carries no action buttons; the operator never clicks
"kill container" here. Any *action* still goes through the agent in
chat (§5). That boundary is what keeps the Host tab on the right side
of the "no shell-shaped affordances" line.

This supersedes the earlier "no new tab" framing: ops sessions are
different enough that a dedicated read-only panel is the correct
inline surface, and the conditional-tab pattern makes it cheap.

### What we explicitly do NOT do

- **No host access beyond Docker + journal.** No `/proc`, no `/sys`,
  no `/etc`, no SSH from inside the container.
- **No mutation of Docker state.** Read-only via proxy.
- **No automatic creation** of the ops session — the operator
  bootstraps it deliberately. We never silently provision a
  privileged session.
- **No CLI button to "run `docker stop`."** That would be §5 — a
  shell-shaped affordance. The agent runs the commands; the operator
  asks the agent.

## Implementation steps

(Numbers are work units, not ordered phases — most can land
independently.)

1. **`docker-socket-proxy` packaging** — add a hardened compose
   service definition that exposes `CONTAINERS=1`, `EVENTS=1`,
   `IMAGES=1`, `INFO=1`, `NETWORKS=1`, `VOLUMES=1`, `SERVICES=0`,
   `POST=0`, etc. (the allow-list matrix is in the proxy's README).
   Lives in `docker/ops-session/docker-compose.proxy.yml`.

2. **Ops session template** — a workspace template
   (`src/server/orchestrator/templates*.ts` family) that produces the
   `ops/` workspace contents above. Reachable from the
   `POST /api/sessions/from-template` route with `template: "ops"`.
   The template is gated — only the operator can pick it (auth
   check on the route).

3. **Privileged mount support** — `shipit.yaml` currently doesn't
   support mounting arbitrary host paths into the agent container.
   Add `x-shipit-host-mounts:` (top-level, NOT under a service) with
   strict allow-listing: only `/var/run/docker.sock` (via proxy
   path) and `/var/log/journal`, `/run/log/journal`. Anything else
   is rejected. Validation in
   `src/server/shared/shipit-config.ts`. This is the smallest blast-radius
   way to expose privileged mounts — no syntax for arbitrary paths.

4. **Container creation respects host mounts** — `container-lifecycle.ts`
   `createContainer` reads the allow-listed mounts and adds them to
   `HostConfig.Mounts` with `ReadOnly: true`. Guards: the feature only
   activates when the agent container is being created for a session
   whose workspace has the `ops`-template marker file (e.g.,
   `.shipit/ops-session-marker`). Without the marker, the mounts are
   silently dropped. Defense-in-depth so a user-modified `shipit.yaml`
   can't smuggle in mounts.

5. **Session `kind` + sidebar group** — add a `kind?: "ops"` field to
   `SessionInfo` (`src/server/shared/types/domain-types.ts`); there is
   no `kind` field today, session types are distinguished by ad-hoc
   flags (`warm`, `parentSessionId`, `mergedAt`), so this one field is
   what drives both the grouping and the tab logic. Render the ops
   session in its own pinned **"Host / Ops"** group in
   `SessionSidebar.tsx` (separate from `RepoGroup` and
   `OrphanSessionGroup`), with a subtle "ops" badge on the card.
   Default title from the template is `Ops — {hostname}`.

5a. **Settings create affordance** — add a gated "Ops / Host" section
   to `Settings.tsx` with a short explainer and a "Create ops session
   for this host" button that POSTs to `/api/sessions/from-template`
   with `template: "ops"`. The button is the operator gate's UI
   surface — shown/enabled only for the host operator (see "Auth
   gate"). No phantom card appears in the sidebar before creation.

5b. **Read-only "Host" tab** — add `"host"` to the `RightTab` union
   (`src/client/stores/ui-store.ts`) and gate its tab button + the
   Preview/PR hides on `kind === "ops"` in `App.tsx` (same conditional
   pattern as the existing `isLocalMode` / `composeServices.length`
   checks). The tab content renders, read-only, the orchestrator's
   existing host signals — session-container list with status +
   health, per-session log-ring tails, container-health-monitor
   verdicts, and a `docker events` / journal tail. New read endpoints
   are needed to feed it (the orchestrator collects these signals but
   doesn't expose them to the client yet); add them following the
   `add-endpoint` skill. **No action buttons** — informational only;
   mutations go through the agent in chat (§5).

6. **Pre-baked investigation prompts** — write the three prompts under
   `prompts/` and link them from the template's README. Each prompt
   is a self-contained, paste-and-go investigation for a recurring
   debug scenario.

7. **Docs in `shipit-docs/`** — add `shipit-docs/ops-session.md` so
   the agent inside the ops session knows what it can and can't do
   (read-only Docker, read-only journal, where to look, examples).

8. **Tests**:
   - Integration: ops template produces the expected workspace shape;
     gating works (non-operator can't create it).
   - Unit: `shipit.yaml` parser rejects host mounts outside the
     allow-list.
   - Integration: container with the marker file gets the mounts;
     same workspace without the marker doesn't.
   - Client: a `kind: "ops"` session renders in the "Host / Ops"
     group, not in a repo or orphan group; Preview/PR tabs are hidden
     and the Host tab is present.
   - Gating: the Settings "Create ops session" button is hidden/
     disabled for a non-operator.

## Risks / open questions

- **Read-only journal access is platform-specific.** `/var/log/journal`
  is the persistent location, `/run/log/journal` the volatile fallback.
  On hosts where journald is configured for `Storage=volatile`, only
  `/run/log/journal` exists. The template should bind-mount whichever
  exists; if neither does (no systemd journal), the prompts fall back
  to `docker logs` on the orchestrator container.
- **What about non-systemd hosts?** Some prod deployments may run
  ShipIt in a way where the journal isn't on the host filesystem
  (e.g., logs go to stdout / a log aggregator). For those, the journal
  mount is a no-op and the prompts default to `docker logs`-based
  investigation. Document this.
- **Single ops session vs per-incident.** Should the operator have one
  long-lived ops session or create a fresh one per incident? V1: one
  long-lived. The session's chat history doubles as an incident log,
  which is useful for post-mortems. If chat history grows unwieldy,
  the operator can archive and bootstrap a new one.
- **Operator-only gate enforcement.** ShipIt's existing auth doesn't
  distinguish "operator" from "user." In single-tenant deployments
  this is fine (one user, that user is the operator). For
  multi-tenant we'd need an operator role — defer.
- **What if the operator breaks the ops session itself?** Then they
  bootstrap a new one from the template. The ops session shouldn't
  be load-bearing for any other ShipIt functionality.

## Why this is worth doing

Every debug session for the past several incidents has involved the
same pattern: operator notices something off → switches to terminal
→ SSH to prod → runs `docker ps`, `journalctl`, `dmesg` in some
order → returns to chat → pastes results → asks for the next command.
The SSH context-switch is friction and the multi-command
investigations are reconstructed each time from chat.

The ops session collapses that loop. The operator stays in ShipIt,
asks the agent ("anything looking off in the last hour?"), and the
agent — which already has read-only Docker + journal access via the
proxy and mount — runs the prompts directly. The investigation logs
themselves become part of the session's chat history, which is the
audit trail for the next incident.

## Out of scope (might be follow-ups)

- **Write access to Docker for actions like "kill orphan container."**
  Possible follow-up once we trust the read-only flow. Would require a
  separate, explicit user confirmation per action.
- **Inline preview of the host's metrics dashboard.** Different
  feature; could be embedded as a manual compose service in the ops
  session's workspace (Grafana, Prometheus, etc.).
- **Multi-host ops** (one ShipIt UI debugging several prod hosts).
  Defer until ShipIt itself runs in multi-host deployments.
- **A loud alert when `LOOP DETECTED` fires.** The detector
  (`docs/124-session-rescue-and-diagnostics` follow-up) already writes
  the line to journalctl + the per-session ring. An auto-DM/email
  alert is a separate feature.
