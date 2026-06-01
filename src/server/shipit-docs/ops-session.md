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
  `/run/log/journal` (volatile) are mounted read-only. Pass the directory
  explicitly with `-D` — a bare `journalctl` reads *this container's* journal
  (whose machine-id doesn't match the host's, so it returns "No journal files
  were found"); `-D /var/log/journal` points it at the host's mounted journal:
  ```bash
  journalctl -D /var/log/journal --since "1 hour ago" --no-pager
  journalctl -D /var/log/journal --since "1 hour ago" --no-pager | grep "LOOP DETECTED"
  ```
  This host uses **persistent** journal storage, so `/var/log/journal` is the
  populated path; `/run/log/journal` exists but is empty here. If neither path is
  populated (journald is `Storage=volatile` with no `/run` journal, or the host
  ships logs elsewhere), fall back to `docker logs` on the orchestrator container.

- **Read-only ShipIt source.** When the incident is likely a ShipIt bug, read
  the source code that runs *this host* — the exact deployed commit, served by
  the orchestrator (not a generic clone, not the repo's default branch):
  ```bash
  shipit source status                                   # which commit, exact or approximate
  shipit source tree src/server/orchestrator              # list a directory
  shipit source search "ContainerSessionRunner"           # git grep at that commit
  shipit source cat src/server/orchestrator/session-container.ts
  shipit source log src/server/orchestrator/container-lifecycle.ts  # recent commits touching a path
  shipit source blame src/server/orchestrator/container-lifecycle.ts # who last changed each line
  shipit source show <commit> [path]                      # a commit's metadata + diff
  ```
  This is strictly read-only. Credentials, `.env` files, and `.git` internals
  are redacted (including inside `show` diffs). `shipit source status` tells you
  whether the snapshot is the **exact** deployed build or only an **approximate**
  checkout HEAD — carry that distinction into any fix you propose. For a
  regression, `log`/`blame`/`show` are the fastest way to connect a symptom to
  the change that introduced it.
- **Spawn a ShipIt fix session.** Once you have a root-cause hypothesis and the
  suspect files, delegate the fix to a normal repo-backed session branched from
  the exact commit you inspected:
  ```bash
  shipit session create --shipit-source -p "<diagnosis + suspected files + constraints>"
  shipit session wait <child-id>      # follow it; view / message it like any spawned session
  ```
  The child owns all edits, tests, commits, push, and the PR — you only read its
  status. It requires that the operator's GitHub account can push to the ShipIt
  repo; if it cannot, the command fails and you should produce a written
  incident report with source references instead. If the source ref was only
  approximate, add `--approximate` to acknowledge it.

  The child's branch *starts* at the exact deployed commit so it can reproduce
  the bug against the code that's actually running — which is usually behind the
  repo's default branch. Its incident packet instructs it to rebase onto the
  latest default branch before opening the PR, so the PR stays mergeable. Fix
  sessions also have a lower per-turn spawn cap than generic fan-out children, so
  spawn one deliberate, well-scoped fix per diagnosis rather than several.

## What you CANNOT do (by design)

- **No Docker writes.** `docker stop`, `docker rm`, `docker kill`,
  `docker exec`, `docker build`, image pulls/pushes — all rejected by the proxy.
  If a container genuinely needs to be killed or restarted, report your finding
  and let the operator act on the host directly.
- **No other host paths.** No `/etc`, `/root`, `/home`, `/proc`, `/sys`. No SSH.
- **The real `/var/run/docker.sock` is not mounted here** — only the proxy holds
  it. You reach Docker over TCP, never the socket.
- **No writes to ShipIt source.** `shipit source` is read-only — there is no
  `edit`, `commit`, `push`, `checkout`, or `git` subcommand. Change ShipIt only
  through a spawned `--shipit-source` fix session, which goes through the normal
  Git + PR machinery.

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
