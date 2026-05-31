/**
 * docs/128 — Ops session template.
 *
 * The ops session is a privileged host-debugging session: the agent gets
 * read-only Docker access (via a hardened `docker-socket-proxy` sibling over
 * TCP) and read-only systemd journal mounts, so an operator can debug the
 * production ShipIt host without leaving the UI.
 *
 * This template only carries the *workspace contents* (README, shipit.yaml,
 * docker-compose.yml, prompts/). The privilege itself is gated on the
 * server-authoritative `session.kind === "ops"` field — set at creation by
 * `applyTemplate` (services/templates.ts), never by anything in the workspace.
 * A non-ops session that copies this `shipit.yaml` gets its host mounts
 * silently dropped (see container-lifecycle.ts).
 */

import type { ProjectTemplate } from "../shared/types.js";

export const OPS_TEMPLATE_ID = "ops";

/**
 * Hardened docker-socket-proxy compose service. The real `/var/run/docker.sock`
 * is mounted only into this sibling — never the agent container. Read-only API
 * surface: containers/events/images/info/networks/volumes are allowed; every
 * mutating or sensitive endpoint (POST, EXEC, secrets, swarm, build) is denied.
 */
const DOCKER_COMPOSE_YML = `# docs/128 — read-only Docker access for the ops session.
#
# This proxy is the ONLY place the host Docker socket is mounted. The agent
# container reaches it over TCP (DOCKER_HOST=tcp://docker-socket-proxy:2375,
# set automatically by the orchestrator for kind="ops" sessions) and can only
# perform the read-only operations enabled below. Mutating endpoints (stop, rm,
# exec, build, secrets) are rejected by the proxy.
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:0.3.0
    x-shipit-preview: auto
    x-shipit-depends-on-install: false
    restart: unless-stopped
    environment:
      # --- allowed (read-only) ---
      CONTAINERS: 1
      EVENTS: 1
      IMAGES: 1
      INFO: 1
      NETWORKS: 1
      VOLUMES: 1
      VERSION: 1
      PING: 1
      # --- denied (mutating / sensitive) ---
      POST: 0
      BUILD: 0
      COMMIT: 0
      EXEC: 0
      AUTH: 0
      CONFIGS: 0
      DISTRIBUTION: 0
      GRPC: 0
      NODES: 0
      PLUGINS: 0
      SECRETS: 0
      SERVICES: 0
      SESSION: 0
      SWARM: 0
      SYSTEM: 0
      TASKS: 0
    volumes:
      # Read-only mount of the host socket into the PROXY only.
      - /var/run/docker.sock:/var/run/docker.sock:ro
`;

const SHIPIT_YAML = `# docs/128 — ops session config.
version: 1

# Brings up the read-only docker-socket-proxy sibling (see docker-compose.yml).
compose:
  file: docker-compose.yml

# Privileged read-only host mounts for the AGENT container. Strictly
# allow-listed by the orchestrator (src/server/shared/shipit-config.ts) — only
# the systemd journal paths are permitted here, and only ever read-only. These
# mounts are honored ONLY because this session was created with the
# server-authoritative kind="ops" flag; copying this file into an ordinary
# session does nothing (the mounts are dropped).
#
# The Docker socket is intentionally NOT listed here — the agent reaches Docker
# through the proxy over TCP, never by mounting the socket.
x-shipit-host-mounts:
  - /var/log/journal   # persistent journal
  - /run/log/journal   # volatile journal (fallback when storage=volatile)
`;

const README_MD = `# Ops session — debug this ShipIt host

This is a **privileged ops session** (docs/128). The agent here can inspect the
production host that ShipIt runs on, **read-only**:

- **Docker (read-only):** \`docker ps\`, \`docker logs\`, \`docker inspect\`,
  \`docker events\`, \`docker stats\` — routed through a hardened
  \`docker-socket-proxy\` sibling. Mutating commands (\`stop\`, \`rm\`, \`kill\`,
  \`exec\`) are **rejected** by the proxy.
- **Journal (read-only):** \`journalctl\` over the host's \`/var/log/journal\`
  (or \`/run/log/journal\`), mounted read-only.

That is the entire privilege surface. No \`/etc\`, no \`/root\`, no SSH, no write
access to Docker. See \`/shipit-docs/ops-session.md\` for the full contract.

## Investigation recipes

Paste one of these into chat instead of reconstructing the commands from memory:

- [\`prompts/investigate-loop.md\`](prompts/investigate-loop.md) — find a
  container stuck in a SIGTERM/recreate loop (\`LOOP DETECTED\`).
- [\`prompts/diagnose-stuck-session.md\`](prompts/diagnose-stuck-session.md) —
  diagnose a single misbehaving session container.
- [\`prompts/daily-health.md\`](prompts/daily-health.md) — a daily host-health
  snapshot.

## How to act

This session has **no action buttons**. To *do* something (e.g. kill an orphan
container) you ask the agent in chat — and even then the read-only proxy will
reject mutations, so write actions require the operator to act on the host
directly. Read-only by design.
`;

const PROMPT_INVESTIGATE_LOOP = `# Investigate a container restart loop

A session container looks like it's stuck in a SIGTERM → recreate loop. Find it
and explain why.

1. Grep the journal for the loop detector and recent container churn:
   \`\`\`
   journalctl --since "1 hour ago" --no-pager | grep -E "LOOP DETECTED|SIGTERM|recreat|OOM|Killed"
   \`\`\`
2. List containers and spot any with a high restart count or short uptime:
   \`\`\`
   docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.RunningFor}}'
   \`\`\`
3. For the suspect container, inspect its restart policy and last exit:
   \`\`\`
   docker inspect <name> --format '{{.RestartCount}} {{.State.ExitCode}} {{.State.Error}} {{.State.OOMKilled}}'
   \`\`\`
4. Tail its logs and the orchestrator journal around the restart timestamps.

Report: which container, the loop cause (OOM? failed healthcheck? crash on
boot?), and whether it's still looping now.
`;

const PROMPT_DIAGNOSE_STUCK_SESSION = `# Diagnose a stuck session container

A specific session (give me the session id or container name) is unresponsive or
behaving oddly. Figure out what's wrong — read-only.

1. Find its container and current state:
   \`\`\`
   docker ps -a --filter "name=<session-id-or-name>" --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'
   docker inspect <name> --format '{{json .State}}' | python3 -m json.tool
   \`\`\`
2. Resource pressure — is it pinned at its memory/cpu cap?
   \`\`\`
   docker stats --no-stream <name>
   \`\`\`
3. Recent logs from the container and the orchestrator's journal for that
   session id:
   \`\`\`
   docker logs --tail 200 <name>
   journalctl --since "30 min ago" --no-pager | grep <session-id>
   \`\`\`
4. Check its compose siblings (if any) on the same network are healthy.

Report: the likely root cause and the smallest corrective action — but do NOT
attempt any mutation here (the proxy is read-only). If a restart/kill is needed,
say so and I'll act on the host.
`;

const PROMPT_DAILY_HEALTH = `# Daily host health snapshot

Give me a quick read-only health snapshot of this ShipIt host.

1. Daemon + host overview:
   \`\`\`
   docker info --format 'Containers: {{.Containers}} (running {{.ContainersRunning}}), Images: {{.Images}}, Mem: {{.MemTotal}}'
   \`\`\`
2. Anything unhealthy, restarting, or recently exited:
   \`\`\`
   docker ps -a --format 'table {{.Names}}\\t{{.Status}}' | grep -Ei "unhealthy|restarting|exited" || echo "all clean"
   \`\`\`
3. Top memory/cpu consumers right now:
   \`\`\`
   docker stats --no-stream --format 'table {{.Name}}\\t{{.MemUsage}}\\t{{.CPUPerc}}' | head -15
   \`\`\`
4. Journal errors in the last 24h:
   \`\`\`
   journalctl --since "24 hours ago" -p err --no-pager | tail -40
   \`\`\`

Report: overall verdict (healthy / degraded), and anything worth watching.
`;

export const OPS_TEMPLATE: ProjectTemplate = {
  id: OPS_TEMPLATE_ID,
  name: "Ops session",
  description: "Privileged read-only host-debugging session (Docker + journal).",
  category: "utility",
  icon: "Wrench",
  files: {
    "README.md": README_MD,
    "shipit.yaml": SHIPIT_YAML,
    "docker-compose.yml": DOCKER_COMPOSE_YML,
    "prompts/investigate-loop.md": PROMPT_INVESTIGATE_LOOP,
    "prompts/diagnose-stuck-session.md": PROMPT_DIAGNOSE_STUCK_SESSION,
    "prompts/daily-health.md": PROMPT_DAILY_HEALTH,
  },
};
