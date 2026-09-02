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

- **Read-only session server logs.** `docker logs shipit-shipit-1` is **not the
  whole story.** A large class of orchestrator events is written per session
  through `broadcastLog`, which goes to the durable log store and the in-memory
  ring and makes **no console call at all** — so it never appears in the
  orchestrator container's stdout or the journal. Auto-push outcomes, compose
  reconcile failures, container recovery/re-adoption, idle disposal and OOM
  notices all live there. From the host, a failure in that class looks like
  nothing happened:
  ```bash
  shipit session logs 7bc72326                       # full id or the prefix from a log line
  shipit session logs 7bc72326 --since 2h            # ISO-8601, or a relative age: 90s/30m/2h/3d
  shipit session logs 7bc72326 --since 2026-08-14T20:00:00Z --until 2026-08-15T02:00:00Z
  shipit session logs 7bc72326 --lines 500 --json
  ```
  What comes back is **narrower than "the session's logs", deliberately**: only
  lines whose whole text is one ShipIt itself authored — a fixed template whose
  variable parts are ShipIt-controlled tokens (a count, an exit code, a
  duration). The agent CLI's stdout/stderr, preview errors from the user's app,
  install output, and any orchestrator line that quotes workspace content or a
  raw error message are all withheld; no flag reaches them (see the boundary
  below). Matched lines are then redacted like the rest of the ops surface.

  Lines that were withheld are **counted and reported**, not silently dropped —
  `withheld: N server line(s) …`, followed by a `by shape:` breakdown. The
  breakdown is ShipIt's own label for each producer plus a count; no part of a
  withheld line is in it. Read it as triage: one label carrying almost all of the
  count is a chatty producer and usually not your incident, while a spread — or a
  large `unclassified ×N`, which is where a producer whose wording drifted off
  its template lands — is a reason to ask the operator to read the session's Logs
  panel for that window.

  **Push outcomes are reported on both sides, so silence means something.** A
  successful auto-push writes `Auto-push completed in Nms: N commit(s) were
  ahead of the last known remote tip.` — or `nothing was ahead …` — alongside
  the existing rejection, deferral and failure lines. So "did the last five
  turns push?" is answerable here: a run of completions, a run of `nothing was
  ahead`, or an explicit failure. Read the two halves of that line differently:
  the push **completing** is a fact, the **count** is ShipIt's own pre-push
  measurement against its local view of the remote, which can be stale. What the
  failure lines do NOT carry is git's own message: a failure prints
  `Auto-push failed (<class>). …` and puts git's words on a separate `Git said:`
  line that stays withheld.

  It reads the durable store, so a session whose container is already gone still
  answers. If a session's logs were pruned — archive, delete, or full reset
  removes them — the output says so explicitly. Read that carefully: an empty
  window and a pruned history look the same otherwise, and "no lines" is not
  evidence that nothing happened.

  One more reason not to read absence as proof: the underlying channel keeps a
  bounded tail (docs/192 rotates it), and it is a *mixed* stream, so a session
  whose agent wrote a lot of output can push its own older server lines out of
  retention. On a busy session, treat a quiet distant past as "not retained",
  not as "nothing happened then".

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

## Your workspace git — ShipIt does not commit it

An ops workspace **is** a real git repo on its own branch, but ShipIt runs **no**
automatic commit and **no** automatic push for it. The auto-commit guidance in
`environment.md` and `github.md` describes ordinary sessions and does **not**
apply here.

- Nothing sweeps up your edits at the end of a turn. `git add` and `git commit`
  yourself when a change is worth keeping for the rest of *this* investigation;
  scratch can stay uncommitted, and will.
- Stay on the current branch — `git checkout -b` / `git switch -c` are blocked.
- There is no remote, so a commit here does not travel: this history has exactly
  one reader, this session. A finding that must outlive this workspace belongs in
  an issue, in a `report_shipit_bug` filing, or in the `--shipit-source` fix
  session that owns the code change. A new or corrected `prompts/` recipe goes
  upstream too — see "Adding a recipe" below.
- `git status` / `git diff` / `git log` are trustworthy here, unlike in an
  ordinary session: the tree is exactly what you left it.

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

  `shipit session logs` does not weaken this, and the reason is worth stating
  precisely — because the obvious version of it *would* have.

  The durable log channel is a *mixed* stream: the same file carries the agent
  CLI's own stdout/stderr alongside the orchestrator's lifecycle lines. Filtering
  that stream by its `source` label is **not** enough, and an early version of
  this subcommand that did so was wrong. `"server"` names the producer, not the
  content, and several orchestrator producers interpolate text they don't
  control: an invalid value in a project's own `docker-compose.yml` is quoted
  verbatim into a validation error that is then broadcast as a `"server"` line.

  So the filter is on the **content**. A line is returned only when its whole
  text matches a template ShipIt authored, whose variable parts are
  ShipIt-controlled tokens. Free-text interpolation cannot match one, so a line
  carrying workspace, agent, or user content is withheld by construction rather
  than by an audit someone has to keep correct. Unmatched lines are counted and
  reported. If the question genuinely needs the session's chat — or one of those
  withheld lines — that is still an "ask the operator to open it in the UI"
  answer.
- **No writes to ShipIt source.** `shipit source` is read-only — there is no
  `edit`, `commit`, `push`, `checkout`, or `git` subcommand. Change ShipIt only
  through a spawned `--shipit-source` fix session, which goes through the normal
  Git + PR machinery.

## Where to look first

- `prompts/trace-a-pr.md` — take a PR, branch, or container name back to the
  session that produced it.
- `prompts/read-session-logs.md` — when the orchestrator log shows nothing:
  read a session's own server-source log lines.
- `prompts/investigate-loop.md` — a container stuck in a SIGTERM/recreate loop.
- `prompts/diagnose-stuck-session.md` — one misbehaving session container.
- `prompts/daily-health.md` — a quick host-health snapshot.
- `prompts/remediate-shipit-bug.md` — turn a diagnosis into a fix session or a
  filed bug.
- `prompts/verify-ops-access.md` — check that the privileges above actually work.

These are paste-and-go recipes. The session's chat history doubles as the
incident log, so investigations are self-documenting for the next time.

### Adding a recipe

These files are **not** authored in this workspace. Each one is a string constant
in `src/server/orchestrator/templates-ops.ts`, listed in `OPS_TEMPLATE.files` and
written into every ops workspace at session creation. A `prompts/*.md` you write
and commit here is therefore read by this session only — the next ops session gets
a fresh workspace from the template and never sees it.

So when an investigation produces a command sequence worth keeping — and that is
worth doing — draft it locally, then send it upstream through a `--shipit-source`
fix session (see "Spawn a ShipIt fix session" above): add the constant to
`templates-ops.ts`, register it in `OPS_TEMPLATE.files`, and add a line to the
list above. That is the same channel as any other ShipIt code change, and it gives
a file shipped to every future ops session a review step before it lands.

## Why read-only

The whole point is to debug the host *without* the risk of a debugging session
mutating production Docker state. Reads are safe and reversible; writes are not.
Keep investigations read-only and hand any corrective action back to the
operator.
