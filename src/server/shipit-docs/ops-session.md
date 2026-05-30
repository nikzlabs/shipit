# Ops session — host debugging (read-only)

If you are reading this inside an **ops session**, you are running on (or
alongside) the production ShipIt host with a deliberately narrow set of
privileges for **read-only** debugging. This doc is your contract: what you can
do, what you cannot, and where to look.

An ops session is created from ShipIt's Settings ("Ops / Host" → "Create ops
session for this host"). It is marked server-side with `kind: "ops"`, which is
the *only* thing that unlocks the privileges below. Copying this session's
`shipit.yaml` into an ordinary session does nothing — the host mounts are
dropped unless the session was created as an ops session.

## What you can do

- **Read-only Docker.** `DOCKER_HOST` points at a hardened
  `docker-socket-proxy` sibling, so the usual commands work:
  ```bash
  docker ps -a
  docker logs --tail 200 <name>
  docker inspect <name>
  docker stats --no-stream
  docker events --since 10m
  ```
- **Read-only systemd journal.** `/var/log/journal` (persistent) and/or
  `/run/log/journal` (volatile) are mounted read-only:
  ```bash
  journalctl --since "1 hour ago" --no-pager
  journalctl --since "1 hour ago" --no-pager | grep "LOOP DETECTED"
  ```
  If neither path exists (journald is `Storage=volatile` with no `/run`
  journal, or the host ships logs elsewhere), fall back to `docker logs` on the
  orchestrator container.

## What you CANNOT do (by design)

- **No Docker writes.** `docker stop`, `docker rm`, `docker kill`,
  `docker exec`, `docker build`, image pulls/pushes — all rejected by the proxy.
  If a container genuinely needs to be killed or restarted, report your finding
  and let the operator act on the host directly.
- **No other host paths.** No `/etc`, `/root`, `/home`, `/proc`, `/sys`. No SSH.
- **The real `/var/run/docker.sock` is not mounted here** — only the proxy holds
  it. You reach Docker over TCP, never the socket.

## Where to look first

- `prompts/investigate-loop.md` — a container stuck in a SIGTERM/recreate loop.
- `prompts/diagnose-stuck-session.md` — one misbehaving session container.
- `prompts/daily-health.md` — a quick host-health snapshot.

These are paste-and-go recipes. The session's chat history doubles as the
incident log, so investigations are self-documenting for the next time.

## Why read-only

The whole point is to debug the host *without* the risk of a debugging session
mutating production Docker state. Reads are safe and reversible; writes are not.
Keep investigations read-only and hand any corrective action back to the
operator.
