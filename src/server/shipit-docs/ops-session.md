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

  If `-D` returns only a few user-scoped lines plus the hint *"you are currently
  not seeing messages from other users and the system"*, that is a **permissions**
  failure, not an empty journal: the host's files are `0640 root:systemd-journal`
  and your uid isn't in the owning group. Confirm with `id` — you should be in a
  group whose GID matches `stat -c '%g' /var/log/journal`. The container
  entrypoint arranges that at boot and logs to stderr when it can't, so
  `docker logs <this-container> 2>&1 | grep shipit-entrypoint` says why. Report
  it rather than working around it; the journal is supposed to work here.

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
- **Read-only session inventory.** The orchestrator knows which session owns
  every branch, PR, and container on this host. Ask it instead of correlating
  journal timestamps against container names:
  ```bash
  shipit session find --branch shipit/kmwodw            # branch → the session
  shipit session find --pr 1744                          # PR number → the session
  shipit session find --container agent-83292266-744     # container → the session
  shipit session find --id 83292266                      # a truncated id from a log line
  shipit session list --all                              # the whole host inventory
  ```
  `--container` takes a name exactly as `docker ps` or the journal prints it —
  the session container (`agent-<id-slice>`) or one of its Compose siblings
  (`shipit-<id-slice>-web-1`). A project's own compose file can set an explicit
  `container_name:`, and such a container carries no session id in its name; the
  error says so and points you at the authoritative fallback:
  ```bash
  docker inspect payments-db --format '{{index .Config.Labels "shipit-parent-session"}}'
  # (or "shipit-session-id" for a session container), then pass that to --id
  ```
  `--pr` matches the session's *current* PR and the one immediately before it on
  the same branch, so a branch that carried #1741 and then #1744 resolves from
  either number. Only one prior PR is retained, so a branch that shipped three
  or more resolves from the latest two — for an older one, look it up by
  `--branch` instead.

  Two classes are excluded from the *default* listing and each has a flag:
  sessions the user archived (`--include-archived` — reach for it when the
  triage subject is already finished) and warm pool sessions
  (`--include-warm` — pre-provisioned shells with no branch, PR, or user). A
  disk-**evicted** session is NOT hidden: eviction happens to ordinary live
  sessions on the idle ladder, so those are exactly the older sessions you're
  usually asking about. Results are capped; when there are more, the output
  names the exact `--offset N` for the next page. Every subcommand takes
  `--json`.

  This is **metadata only**: id, title, kind, branch, repo, parent session,
  agent/model, timestamps, container name, and the PR number/url/state. It does
  **not** return another session's conversation, prompts, queued messages,
  assistant output, secrets, env, or workspace contents. You can see *that* a
  session exists and *what it owns* — never what was said inside it. If you need
  a session's chat, ask the operator to open it in the UI.

  This replaces the old dead end where the only way from a PR to a session was
  guessing between candidate UUIDs by timestamp. Reach for it first.

- **Spawn a ShipIt fix session.** Once you have a root-cause hypothesis and the
  suspect files, delegate the fix to a normal repo-backed session branched from
  the exact commit you inspected:
  ```bash
  shipit session create --shipit-source --prompt-file - --title "Fix container recreate loop" <<'EOF'
  <diagnosis + suspected files + constraints>
  EOF
  shipit session wait <child-id>      # follow it; view / message it like any spawned session
  ```
  `--shipit-source` **requires `--title`** — the diagnosis lives in the incident
  packet, so it can't name the session; pass a short, human-readable title
  describing the fix (a spawn with no title exits non-zero before any child is
  created). The prompt is passed via `--prompt-file` (a file, or `-` for stdin) —
  never an inline `-p`/`--prompt`, so backticks and `$(...)` in your diagnosis
  survive verbatim. Use a single-quoted heredoc as shown.
  The child owns all edits, tests, commits, push, and the PR — you only read its
  status. It requires that the operator's GitHub account can push to the ShipIt
  repo; if it cannot, the command fails — file the diagnosis as a redacted bug
  report instead (see "File a ShipIt bug" below) rather than dead-ending as text.
  If the source ref was only approximate, add `--approximate` to acknowledge it.

  The child's branch *starts* at the exact deployed commit so it can reproduce
  the bug against the code that's actually running — which is usually behind the
  repo's default branch. Its incident packet instructs it to rebase onto the
  latest default branch before opening the PR, so the PR stays mergeable. Fix
  sessions also have a lower per-turn spawn cap than generic fan-out children, so
  spawn one deliberate, well-scoped fix per diagnosis rather than several.

- **File a ShipIt bug.** When you've diagnosed a host bug but can't spawn a fix
  session (the operator's GitHub account lacks push access to the ShipIt repo),
  don't dead-end as a text report — file it through the bug-filing flow with the
  `report_shipit_bug` tool. As an ops session you're the highest-quality producer:
  attach your root-cause summary, the suspected files, and the **redacted**
  Docker/journal evidence you gathered. ShipIt redacts the body server-side, posts
  an inline consent card the operator confirms, and only then opens an issue on the
  upstream repo under their own GitHub identity (marked `source:ops`). Downstream, a
  developer with push access can pick the issue up as a fix session. See
  `bug-filing.md` for the tool contract and what never goes in the body.

## What you CANNOT do (by design)

- **No Docker writes.** `docker stop`, `docker rm`, `docker kill`,
  `docker exec`, `docker build`, image pulls/pushes — all rejected by the proxy.
  If a container genuinely needs to be killed or restarted, report your finding
  and let the operator act on the host directly.
- **No other host paths.** No `/etc`, `/root`, `/home`, `/proc`, `/sys`. No SSH.
- **The real `/var/run/docker.sock` is not mounted here** — only the proxy holds
  it. You reach Docker over TCP, never the socket.
- **No reading another session's conversation.** `shipit session find` /
  `list --all` return inventory metadata only. There is no subcommand that
  returns another session's chat history, prompts, queued messages, assistant
  output, secrets, or workspace files, and none will be added — that boundary is
  the reason the inventory surface exists as its own narrow route rather than as
  general access to the sessions API.
- **No writes to ShipIt source.** `shipit source` is read-only — there is no
  `edit`, `commit`, `push`, `checkout`, or `git` subcommand. Change ShipIt only
  through a spawned `--shipit-source` fix session, which goes through the normal
  Git + PR machinery.

## Where to look first

- `prompts/trace-a-pr.md` — take a PR, branch, or container name back to the
  session that produced it.
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
