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
  # The proxy compose service mounts the host Docker socket. The agent still
  # reaches Docker only through the read-only proxy, and only sessions marked
  # server-side as kind="ops" get DOCKER_HOST wired to it.
  docker-socket: true

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
- [\`prompts/verify-ops-access.md\`](prompts/verify-ops-access.md) — verify that
  every privilege in the design doc actually works on this host (run this first
  on a freshly-provisioned ops host).

## How to act

This session has **no action buttons**. To *do* something (e.g. kill an orphan
container) you ask the agent in chat — and even then the read-only proxy will
reject mutations, so write actions require the operator to act on the host
directly. Read-only by design.
`;

const PROMPT_INVESTIGATE_LOOP = `# Investigate a container restart loop

A session container looks like it's stuck in a SIGTERM → recreate loop. Find it
and explain why.

1. Grep the journal for the loop detector and recent container churn. Use
   \`-D /var/log/journal\` — a bare \`journalctl\` reads the agent container's own
   (empty) journal, not the host's mounted one:
   \`\`\`
   journalctl -D /var/log/journal --since "1 hour ago" --no-pager | grep -E "LOOP DETECTED|SIGTERM|recreat|OOM|Killed"
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
   journalctl -D /var/log/journal --since "30 min ago" --no-pager | grep <session-id>
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
4. Journal errors in the last 24h (\`-D /var/log/journal\` so journalctl reads the
   host's mounted journal, not the agent container's empty default):
   \`\`\`
   journalctl -D /var/log/journal --since "24 hours ago" -p err --no-pager | tail -40
   \`\`\`

Report: overall verdict (healthy / degraded), and anything worth watching.
`;

const PROMPT_VERIFY_OPS_ACCESS = `# Verify ops session privileged access

You are running inside a ShipIt **ops session** (docs/128). Verify that every
privilege the design doc promises actually works on this live host, and that the
boundaries it promises hold. Run the checks read-only, then give me a PASS/FAIL
table with the evidence for each row. Do NOT attempt any destructive action
beyond the explicitly-labeled "should be rejected" probes below.

## A. Environment wiring
1. \`printenv DOCKER_HOST\` — confirm it is exactly \`tcp://docker-socket-proxy:2375\`.
2. \`getent hosts docker-socket-proxy\` — confirm the proxy resolves on the compose
   network (non-empty, exit 0).
3. Confirm the real socket is NOT mounted into THIS container:
   \`ls -la /var/run/docker.sock 2>&1\` should be "No such file or directory".

## B. Read-only Docker through the proxy (these must SUCCEED)
4. \`docker info\` and \`docker version\` — daemon reachable through the proxy.
5. \`docker ps -a --format 'table {{.Names}}\\t{{.Status}}'\` — list containers.
6. Pick any running container and run \`docker inspect <name> --format '{{.State.Status}}'\`
   and \`docker logs --tail 5 <name>\`.
7. \`docker events --since 1m --until 1m\` (bounded so it returns) — events readable.
8. \`docker stats --no-stream --format 'table {{.Name}}\\t{{.MemUsage}}'\` — stats readable.

## C. Mutations through the proxy (these must be REJECTED)
For each, report the exact error. They MUST fail (the proxy denies POST/exec):
9.  \`docker stop <some-running-container-name>\` — expect denied (403/forbidden), NOT actually stopped.
10. \`docker exec <some-running-container-name> echo hi\` — expect denied.
11. \`docker run --rm hello-world\` — expect denied (image create/run is a POST).
After running 9, re-check that the target container is still "Up" (proving it
was a true no-op, not a real stop).

## D. Journal host mounts (read-only)
12. \`ls -ld /var/log/journal /run/log/journal 2>&1\` — at least one should exist
    (persistent vs volatile depends on this host's journald Storage setting; if
    only one exists that's expected, note which).
13. From a mounted journal path, confirm it is READ-ONLY: try
    \`touch /var/log/journal/__shipit_probe 2>&1\` (and the /run path) — expect
    "Read-only file system". Do not leave any file behind.
14. Read actual logs. Pass the journal dir explicitly with \`-D\` — a bare
    \`journalctl\` reads THIS container's journal (machine-id mismatch → "No
    journal files were found"), not the host's mounted one:
    \`journalctl -D /var/log/journal --since "1 hour ago" --no-pager | tail -20\`
    (use \`-D /run/log/journal\` if that's the populated path). Confirm you get
    real host log lines.
15. Run one real investigation recipe end-to-end:
    \`journalctl -D /var/log/journal --since "24 hours ago" --no-pager | grep -E "LOOP DETECTED|SIGTERM|OOM|Killed" | tail -20\`
    (empty output is fine — the point is the pipeline runs against host logs).

## E. Negative boundaries (these must NOT be accessible)
16. Confirm no extra host filesystem leaked in: there should be NO host bind of
    \`/var/lib/docker\`, \`/root\`, \`/home\`, or the host \`/etc\`. Spot-check
    \`mount | grep -E "/var/lib/docker|/root|/home"\` returns nothing host-related.

## F. Service visibility
17. Hit the ShipIt service API for this session and confirm \`docker-socket-proxy\`
    shows up as a running service (it should auto-start):
    \`curl -s http://\${SHIPIT_HOST}:\${SHIPIT_PORT}/api/sessions/\${SHIPIT_SESSION_ID}/services\`
    and, if listed,
    \`curl -s ".../services/docker-socket-proxy/logs?lines=30"\`.

## Output
Produce a markdown table: | Check | Expected | Observed | PASS/FAIL |.
Then a one-line overall verdict. For any FAIL, quote the exact command + error so
it can be fixed. Do not summarize as "working" unless B+D actually returned real
host data and C was actually rejected.

## Reading the result
- **B** (real Docker data) and **D** (real host journal lines) are the core
  capabilities — they must pass.
- **C failing is success**: the proxy is supposed to reject mutations. If
  \`docker stop\` actually works, the proxy hardening has regressed — flag it.
- **D may legitimately half-pass**: on a \`Storage=volatile\` host only
  \`/run/log/journal\` exists; on a host with no systemd journal, neither does
  (fall back to \`docker logs\`). Confirm the host has a journal before assuming
  a code bug.
- If **F** shows the proxy missing while **B** works, that's a reporting gap,
  not a functional break.
`;

/**
 * docs/128 — seed prompt for an ops session opened *to investigate another
 * session* (the sidebar "Investigate in Ops session" entry point).
 *
 * The client bakes this into the new ops session's composer draft so the
 * operator lands with the target session's identity and a concrete read-only
 * first step already typed — instead of copy-pasting the session id into a
 * blank ops session by hand. The session id is the handle the agent filters
 * containers by (container names embed it — see
 * prompts/diagnose-stuck-session.md). Mirrors that recipe with the id baked in.
 */
export function buildOpsInvestigationSeed(target: {
  id: string;
  title: string;
  remoteUrl?: string;
  branch?: string;
}): string {
  const ctx: string[] = [`id \`${target.id}\``];
  if (target.branch) ctx.push(`branch \`${target.branch}\``);
  if (target.remoteUrl) ctx.push(target.remoteUrl);
  return `Investigate the session "${target.title}" (${ctx.join(", ")}) — it's misbehaving and I want to know why. Read-only.

1. Find its container and current state:
   \`\`\`
   docker ps -a --filter "name=${target.id}" --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'
   docker inspect <name> --format '{{json .State}}' | python3 -m json.tool
   \`\`\`
2. Resource pressure — is it pinned at its memory/cpu cap?
   \`\`\`
   docker stats --no-stream <name>
   \`\`\`
3. Recent logs from the container and the orchestrator journal for this session:
   \`\`\`
   docker logs --tail 200 <name>
   journalctl -D /var/log/journal --since "30 min ago" --no-pager | grep ${target.id}
   \`\`\`

Report the likely root cause and the smallest corrective action — but don't attempt any mutation (the proxy is read-only). If a restart or kill is needed, tell me and I'll act on the host.`;
}

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
    "prompts/verify-ops-access.md": PROMPT_VERIFY_OPS_ACCESS,
  },
};
