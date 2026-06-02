---
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
| `DOCKER_HOST=tcp://docker-socket-proxy:2375` | Reach the daemon **only** through the read-only proxy (see below) — `docker ps`, `docker logs`, `docker inspect`, `docker events`, `docker stats` | Read access only — proxy rejects stop/rm/exec |
| `/var/log/journal` (read-only) | `journalctl --since`, grep for `LOOP DETECTED`, `[container]`, dispose stack traces | Read access only |
| `/run/log/journal` (read-only, fallback) | Volatile journal when `/var/log/journal` isn't persistent | Read access only |
| `/var/run/docker.sock` — **NOT mounted into the agent container** | The real socket is mounted only into the proxy sibling, never the agent | — |
| `/var/lib/docker` — **NOT mounted** | Avoid leaking container layer data, secrets in env files, etc. | — |
| Other host paths — **NOT mounted** | `/etc`, `/root`, `/home`, etc. stay out | — |

Note the agent reaches Docker over **TCP to the proxy**, not by
mounting a socket. ShipIt already drives the agent container's Docker
path via `DOCKER_HOST`: `container-lifecycle.ts` sets
`DOCKER_HOST=tcp://{dockerProxyHost}:{dockerProxyPort}` whenever a
session has `dockerAccess`. The ops session does **not** use that
read-write session docker-proxy; it points `DOCKER_HOST` at its own
**read-only** `docker-socket-proxy` sibling instead. So the only
privileged *mounts* on the agent container are the two journal paths;
the Docker access is an env var pointed at a hardened TCP endpoint.

The agent's container itself runs with the same resource limits as
any session container (1.5 GB RAM, 0.5 CPU) and does **not** get the
read-write session docker-proxy (`dockerAccess` stays off). The
privilege escalation is **only** read-only Docker (via the hardened
proxy TCP endpoint) and the read-only journal mounts — not Docker
socket write access, not docker-proxy elevation, not capability
grants.

### Read-only socket — how

Docker's socket is fundamentally read-write — any process with write
access to `/var/run/docker.sock` can do anything to the daemon. So
"read-only mount" alone isn't enough; the agent can still `docker
stop`, `docker rm`, `docker exec --privileged` arbitrary containers.

Two options:

1. **Sidecar read-only proxy.** Run a small reverse-proxy container
   (e.g., [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
   that mounts the real `/var/run/docker.sock`, intercepts the Docker
   API, and rejects mutating endpoints (`POST /containers/.../stop`,
   `POST /containers/.../kill`, etc.). The proxy exposes a **TCP
   listener** (`2375`); the agent reaches it via
   `DOCKER_HOST=tcp://docker-socket-proxy:2375` over a shared compose
   network. The agent container never mounts the real socket.
   Battle-tested approach; recommended.

2. **Group-restricted access + agent rule.** Mount the real socket
   but rely on the agent's prompt to not call mutating commands.
   Fragile. Skip.

Pick (1). The proxy is a ~20-line compose service. **It is a sibling
container, not a child of the agent** — ShipIt's `ServiceManager`
(`service-manager.ts`, `docker compose up -d`) starts compose
services as host-level siblings alongside (and after) the agent
container, on the session's compose network. That's exactly the
topology this needs: the proxy mounts the host socket, the agent
talks to it over the compose network via `DOCKER_HOST`, and the two
share the same session lifecycle. It is declared as a normal compose
service in the ops workspace's `docker-compose.yml` (with
`x-shipit-preview` omitted so it doesn't surface in the preview
panel) — no socket bind-mount on the agent container is involved.

### Workspace contents

The ops session's workspace is bootstrapped with:

```
ops/
  README.md            — short doc of what the agent can do here
  shipit.yaml          — declares the docker-socket-proxy compose service and
                         `compose.docker-socket: true`
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

### Fix path vs. issue path — the GitHub write-access fork

A ShipIt deployment is **one human per box** (whoever runs the VPS is the ShipIt
user), and that human **may or may not** have push access to the ShipIt repo. That
single fact already forks what an ops session can do about a ShipIt bug, and the
fork is enforced by `checkRepoWriteAccess` on the spawn route — no operator role is
needed:

- **Has push access (a ShipIt developer):** the ops session spawns a
  `--shipit-source` fix session that branches from the deployed commit and opens a
  PR. (existing path)
- **No push access (a regular self-hosted user):** the spawn 403s. Instead of
  dead-ending as a written incident report, the diagnosis is **filed as a redacted
  issue against the ShipIt repo under the user's own GitHub identity**, via the
  `docs/164` bug-filing flow (anyone can open an issue on the public repo; no push
  needed). The ops session is the highest-quality producer of such a report — it
  has real Docker/journal evidence to redact and attach.

So "enable spawning into the ShipIt repo only for ShipIt developers" needs no new
gate: GitHub authorization *is* the gate, it is self-enforcing, and the no-write
branch degrades to issue-filing rather than failing. The current 403 fallback
message (`api-routes-session.ts`: "Produce a structured incident report … instead")
should be re-pointed at the `docs/164` filing flow when that lands.

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
operator; see "Auth gate"). Creation calls the existing
`POST /api/sessions/:id/template` route with `:id = "new"` and body
`{ templateId: "ops" }` (implementation step 2).

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

2. **Ops session template** — a workspace template that produces the
   `ops/` workspace contents above, applied via the existing
   `POST /api/sessions/:id/template` route with body
   `{ templateId: "ops" }` (`:id` may be `"new"` to create a fresh
   session; see `applyTemplate` in `services/templates.ts`). Note the
   ops template is a **different shape** than the existing project
   scaffolds: today templates are in-memory `files: Record<string,
   string>` maps (`templates.ts` / `ProjectTemplate`) committed into
   the workspace, whereas the ops template must also (a) set the
   server-authoritative `kind: "ops"` on the session and (b) declare
   the privileged journal mounts. So this is not a drop-in entry in
   the existing `getTemplate()` registry — step 2 includes extending
   the template type/flow to carry that extra metadata, or adding a
   dedicated creation path. The template is gated — only the operator
   can pick it (auth check on the route).

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
   `HostConfig.Mounts` with `ReadOnly: true`. **The gate keys off the
   server-authoritative `kind: "ops"` field on the session** (set at
   creation by the gated template route, step 5) — never off a file
   inside the workspace. This is critical: the agent has full write
   access to its own workspace, so a workspace marker file
   (`.shipit/ops-session-marker`) is *forgeable* — any ordinary
   session's agent, or a malicious cloned repo, could write the marker
   plus a crafted `shipit.yaml` and obtain a read-only Docker endpoint
   + journal mounts (a host-wide information disclosure: every
   container's env, secrets, and logs). Because `kind` is set
   server-side at creation and is not writable from inside the
   container, an ordinary session can never flip itself into an ops
   session. A user-edited `shipit.yaml` declaring
   `x-shipit-host-mounts` on a non-ops session has its mounts silently
   dropped.

   Follow-up from field diagnostics: journal mounts must be passed to Docker
   as daemon-validated bind mounts with `CreateMountpoint: false`, not
   preflighted with `fs.existsSync()` in the orchestrator container. In
   production the orchestrator filesystem is not the Docker host filesystem, so
   container-local preflight can silently drop valid host journal paths.

4a. **Ops proxy service starts automatically** — the hidden ops template marks
    `docker-socket-proxy` with `x-shipit-preview: auto` and
    `x-shipit-depends-on-install: false`, and its `shipit.yaml` declares
    `compose.docker-socket: true` because the proxy is a compose service that
    intentionally mounts the host socket. The server-authoritative session kind
    still gates the agent-side ops privileges: the journal host mounts and the
    automatic `DOCKER_HOST=tcp://docker-socket-proxy:2375` environment. Starting
    the proxy through compose creates the
    `shipit-session-{id}` network; the existing network join hook then attaches
    the agent container so `DOCKER_HOST=tcp://docker-socket-proxy:2375` resolves
    by compose DNS.

4b. **Provisioning bugs found by the live audit (host `shipit-16gb`).** Running
    the embedded `prompts/verify-ops-access.md` recipe on a real host surfaced
    three regressions that the unit tests had missed:

    - **`DOCKER_HOST` pointed at the read-write session proxy.** Because the ops
      `shipit.yaml` declares `compose.docker-socket: true` (step 4a),
      `resolveAgentDockerLimits` derived agent `dockerAccess: true`, and
      `buildEnv` checked `dockerAccess` *before* `opsSession` — so the agent got
      the write-capable, session-scoping proxy (host-blind for reads, write-
      forwarding) instead of the hardened read-only `docker-socket-proxy:2375`.
      Fix: `buildContainerConfig` now forces `dockerAccess: false` for ops
      sessions (so the read-write proxy + its network are never created), and
      `buildEnv` checks the ops gate first as a structural backstop. The
      `compose.docker-socket` flag now only governs the proxy *service*, never
      the *agent*.
    - **`journalctl` + docker CLI were missing in prod (audit FAIL #4/#5/#14/#15).**
      This had two layers. (a) `journalctl` wasn't installed in the docker-capable
      image; fixed by installing `systemd` in `docker/Dockerfile.session-worker.docker`
      (the binary reads the mounted journal dirs directly; not PID 1). (b) More
      fundamentally, the docker-capable image **wasn't built or wired in prod at
      all**: `dockerImageName` comes from `SESSION_WORKER_DOCKER_IMAGE`
      (app-lifecycle.ts → `setDockerProxy`), which was unset, and `deploy.sh` built
      only the base `shipit-session-worker:prod`. So docker/ops sessions fell back
      to the base image (no `docker`/`journalctl`). Fixed by treating it like every
      other image we build ourselves: a `session-worker-docker` build-only service
      (`deployment/vps/docker-compose.yml`) layers the Docker CLI + journalctl on
      `shipit-session-worker:prod` → `shipit-session-worker:docker`; `deploy.sh`
      builds it right after the base image (a separate build step, no `--pull`,
      since the base is local-only); and the orchestrator env sets
      `SESSION_WORKER_DOCKER_IMAGE=shipit-session-worker:docker`. This also fixes
      ordinary `capabilities.docker` sessions, which shared the same gap. A redeploy
      must run `deploy.sh` (not the no-rebuild `restart.sh`) to build the new image.

    - **Warm-standby bypass — checked, does not exist.** A natural worry is that an
      ops session could be handed a pre-booted *warm standby*, which is built from
      the base image (the warm pool calls `buildConfigForWorkspace` without
      `opsSession`). It can't: `createStandby` is only called by the warm pool, which
      runs per **repo URL**; a standby is keyed by the warm session's own id and is
      claimed only when a session activates under that same id; a session inherits a
      warm id only via the `repoUrl` claim path in `services/session.ts`. Ops sessions
      are minted fresh with `kind="ops"` and **no `remoteUrl`**, so they never enter
      the warm pool and always take the fresh-create path with the ops gate set. No
      code change needed; the invariant is load-bearing and noted in the code.

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
   for this host" button that POSTs to `/api/sessions/new/template`
   with body `{ templateId: "ops" }`. The button is the operator
   gate's UI surface — shown/enabled only for the host operator (see
   "Auth gate"); the route enforces the same gate server-side. No
   phantom card appears in the sidebar before creation.

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

7a. **System-prompt ops overlay** — `shipit-docs/ops-session.md` and the
    `prompts/*.md` recipes are *workspace/reference* files: the agent only
    benefits from them if it (or the operator) reads/pastes them. So a fresh
    ops session whose operator just asks a free-form question
    ("is anything looping?") got the **generic, build-oriented** system prompt
    and had no idea it was a privileged read-only host-debug box — it would try
    Docker mutations (rejected, 403, confusing) and trip over the bare
    `journalctl` "No journal files were found" trap. Fix: `isOps` is now a
    second branching axis on `buildAgentSystemInstructions` (alongside
    `agentId`; both fixed for a session's lifetime, so prompt-cache stability
    holds). When set it (a) splices in an "Ops session" block naming the
    read-only privilege surface + the `journalctl -D /var/log/journal` rule and
    pointing at `ops-session.md` / `prompts/`, (b) swaps the aggressive
    "edited a file ⇒ open a PR" guidance for a read-only variant, (c) drops
    the "scaffold a new project" best practice, and (d) replaces the
    "Live preview" section with a "Compose services" note — the workspace
    `docker-compose.yml` runs only the host-access `docker-socket-proxy`, so
    preview-pane / hot-reload / `x-shipit-preview` guidance is irrelevant and
    would otherwise have the agent treat the proxy like an app frontend.
    Threaded through
    `session-agent-run-params.ts`, which reads `session.kind === "ops"` in the
    pre-`await` DB block (same ordering rule as the other synchronous reads).
    Key files: `agent-instructions.ts`, `session-agent-run-params.ts`.

8. **Tests**:
   - Integration: ops template produces the expected workspace shape;
     gating works (non-operator can't create it).
   - Unit: `shipit.yaml` parser rejects host mounts outside the
     allow-list.
   - Integration: a session with `kind: "ops"` gets the journal
     mounts + read-only-proxy `DOCKER_HOST`; a non-ops session with an
     identical (user-forged) `shipit.yaml` does **not** — the mounts
     are dropped because the gate keys off the server-side `kind`, not
     the workspace.
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
  multi-tenant we'd need an operator role — defer. Note this is *not*
  needed to gate the dangerous capability (spawning a fix PR into the
  ShipIt repo): that is already gated by GitHub push access, which
  forks to issue-filing when absent — see "Fix path vs. issue path".
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

## Contextual entry point: "Investigate in Ops session"

The Settings button creates a *blank* ops session named `Ops —
<hostname>`. But the common trigger is "**this** session is
misbehaving — debug it." Previously the operator created a blank ops
session and then hand-copied the offending session's id into the
chat. That copy-paste is the friction this entry point removes.

Every non-ops session row's overflow (`⋯`) menu in the sidebar now
carries **Investigate in Ops session** (`SessionSidebar.tsx`,
`SessionItem`). It works on any row — active or not — which matters
because a stuck session is often one you don't want to (or can't)
open. The item is hidden on ops rows (no self-investigation).

Data flow (no new races, no new dispatch wiring):

1. The menu item calls the `createOpsSession(targetSessionId)` store
   action (`session-store.ts`), which POSTs the existing
   `/api/sessions/new/template` route with `{ templateId: "ops",
   targetSessionId }`.
2. `applyTemplate` (`services/templates.ts`) treats `targetSessionId`
   as a **reference**, never the templated session — so the fresh-only
   privilege gate is untouched. When the target resolves it (a) names
   the new session `Ops — debug: <title>` and (b) returns a
   `seedPrompt` built by `buildOpsInvestigationSeed` (`templates-ops.ts`),
   which mirrors the `diagnose-stuck-session` recipe with the concrete
   target id baked into the `docker ps --filter` / `journalctl | grep`
   steps. An unknown id is silently ignored → generic ops session.
3. The store writes `seedPrompt` into the new session's composer draft
   via `saveDraftMessage(id, …)` **before** navigation. `MessageInput`
   loads the per-session draft on `focusKey` change, so the operator
   lands in the new ops session with the investigation prompt already
   typed. It is a *draft*, not an auto-dispatched turn: the operator
   reviews and presses send. That keeps a human in the loop on a
   privileged session and sidesteps any race with container boot /
   runner registration (no dependency on `/agent/dispatch`, which 404s
   until a runner exists).

The session id is the right handle because container names embed it —
the agent filters on it directly (same convention the embedded
prompts already use).

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
