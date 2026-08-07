---
issue: planning#331
title: Ops session inventory lookup
description: Ops sessions can resolve a branch, PR, or container name back to the session that produced it — metadata only.
---

# Ops session inventory lookup

Implements [`requirements.md`](requirements.md).

## The gap

The orchestrator's `sessions` table already stores `branch`, `title`, `kind`,
`remote_url`, `parent_session_id`, `root_session_id` and a `pr_status` JSON
snapshot carrying the PR number/url/state. An Ops session — which can already
read the host's full Docker state, the systemd journal, and the deployed ShipIt
source — could reach none of it:

- `GET /api/sessions` → 403 `"This endpoint is not available to session
  containers."` (`api-container-guard.ts`: default-deny, plus the §3 own-session
  scope check, so even an opted-in route is refused when reached for another
  session's id).
- `shipit session list` scopes to `findChildren(callerSessionId)` — children
  only, so an Ops session that spawned nothing gets `[]`.
- `docker exec` into the orchestrator is blocked by the read-only socket proxy,
  by design.

So the one question an Ops session is asked most often when triaging a bad PR —
*which session owns this branch?* — was answerable only by correlating journal
timestamps against container names, and on 2026-08-06 that correlation could not
get below two candidate UUIDs (see `requirements.md` § Motivating incident).

## Shape — follow the `source/*` precedent, leave the guard alone

`api-routes-source.ts` (docs/162) is the template: an Ops-only, read-only
surface that coexists with the container trust boundary without weakening it.
Three properties are copied verbatim:

1. The route lives under the **caller's own** session path
   (`/api/sessions/:id/host-sessions`), so the guard's §3 own-session scope
   check passes untouched.
2. `config: { containerAccessible: true }` plus a `requireOpsSession()` check on
   the server-authoritative `session.kind === "ops"` — 404 when the calling
   session doesn't exist, 403 when it isn't Ops.
3. The worker injects the trusted `SESSION_ID`, so the agent cannot ask on
   another session's behalf.

`api-container-guard.ts` is **not** modified: no cross-session exemption, no
`HARD_DENY_PREFIXES` change, `/api/sessions` stays container-inaccessible
(req 10). The new capability is a *narrower* surface bolted onto the existing
own-session path, not a hole in the boundary.

## Metadata-only boundary (req 8)

`buildHostSessionView` in `services/host-sessions.ts` is an explicit allowlist
projection — it names every field it emits, so nothing new on `SessionInfo`
leaks by default:

| Emitted | Withheld |
|---|---|
| `id`, `title`, `kind`, `branch`, `remoteUrl`¹ | `conversationReplay` |
| `parentSessionId`, `rootSessionId`, `spawnedByTurn` | queued messages / turn state |
| `agentId`, `model` | latest assistant message text |
| `createdAt`, `lastUsedAt`, `mergedAt`, `closedAt` | secrets, tokens, env |
| `warm`, `archived`, `diskTier`, `pinned` | `workspaceDir` and workspace contents |
| `containerName` (derived) | agent session id / provider route |
| `pr`: `number`, `url`, `state`, `baseBranch`, `headBranch` | PR title/body, review comments |
| `previousPr`: `number`, `url` | — |

¹ `remoteUrl` goes through a local `sanitizeRemoteUrlForInventory`, **not** the
repo's usual `git-utils.ts:stripUrlCredentials`, and the difference is the point.
`setGitRemote` (`services/git.ts`) persists whatever string the user supplied,
and `stripUrlCredentials` only rewrites well-formed `http(s)` — deliberately, since
an scp-style `git@github.com:o/r.git` carries an SSH *user*, not a secret, which
is the right call for the surfaces it was written for (showing a URL back to its
own owner). Verified against it, all four of these pass through untouched:

```
ssh://git:pw@example.com/o/r.git             a real password, non-http scheme
https://example.com/o/r.git?access_token=pw  credential in the query string
https://u:pw@                                `new URL` throws → returned as-is
tok@example.com:o/r.git                      scp-style, may be a token
```

Git accepts every one as a remote, so each is reachable. Crossing a session
boundary is exactly where req 8's "no tokens" clause binds, so the inventory
**fails closed**: parse strictly and drop userinfo + query + fragment; if it
will not parse, drop everything up to the last `@`; if nothing usable remains,
omit the field. Losing a legible URL is a fair price for never emitting someone
else's credential — the session id, branch, and PR url already identify the
session. (The upstream persistence gap is a separate pre-existing bug,
deliberately not fixed here: this surface must be safe regardless of what some
other path chose to store.)

The line is deliberately drawn at *"that a session exists and what it owns"*.
An Ops session sees inventory; it never reads what the user said. Note what is
withheld even though it is cheap to add: `latestAssistantMessage` is on the
sibling `ChildSessionView` projection (`services/child-sessions.ts`) and is
correct there — a parent is entitled to its own child's output — but it is
conversation content, so it is not on this projection. Same for
`workspaceDir`: a path is metadata, but it is the one field that turns an
inventory read into a filesystem lead, and nothing in `requirements.md` needs it.

## Route surface

```
GET /api/sessions/:id/host-sessions
    ?branch=<name>          exact branch match
    &pr=<number>            matches pr_status.prNumber OR previous_merged_pr.number
    &container=<name>       docker container name → session id prefix
    &id=<session-id>        exact id, or a unique-enough id prefix
    &includeArchived=true   include sessions the user hid (`userArchived`)
    &includeWarm=true       include warm pool shells
    &limit=<n>              cap the page (default 200, max 500)
    &offset=<n>             skip N matches — pages past the cap (req 5)
```

Filters compose (AND). With none, it is the full inventory, most recently used
first, with two classes excluded by default and each reachable by flag:
user-archived sessions (req 7) and warm pool sessions.

**What is *not* hidden by default: a disk-evicted session.** `diskTier` and
visibility are orthogonal in ShipIt — `SessionManager.list`'s own docstring says
"Disk tier is irrelevant to visibility" (docs/161) — and eviction happens to
ordinary live sessions on the idle ladder after a few days. Filtering evicted
rows out of the default answer would suppress exactly the older sessions a
post-hoc triage question is usually about. Archiving sets `user_archived` *and*
`disk_tier='evicted'`, so keying the default filter on `userArchived` alone is
the strictly narrower, correct cut.

`offset` exists because `limit` is server-capped at 500. Without paging, a host
with more than 500 sessions could never be fully enumerated, which req 5
requires; the response carries `nextOffset` when more remain, so the CLI can
name the exact next command instead of telling the agent to raise a `limit` it
has no power to raise.

**Paging re-sorts on an immutable key, and must.** The SQL orders by
`last_used_at DESC` — right for reading page 1, but *mutable*: a session that
takes a turn between two page requests jumps to the top and shifts every row
after it, so offset paging duplicates one session and silently skips another.
`queryHostSessions` therefore sorts the matched set by `(createdAt DESC, id)`
before slicing: `createdAt` is written once at creation (`markStarted` resets it
only during setup, before a session can be paged over) and `id` is a UUID, so
the pair is a total order no concurrent turn can reshuffle. Without this, req 5's
"fully enumerable" is false on any live host.

A bad `offset` is **rejected**, not clamped — unlike `limit`, which falls back to
the default. A silently-zeroed `--offset -1` returns page 1 dressed as the page
the caller asked for, turning a paging loop into an infinite one. A bad limit
only changes how much you get; a bad offset changes which rows you believe you
have already seen.

Why the id filter is `id=` and not `session=`: the container guard's §3 scope
check falls back to a `?session=` query param when the path has no
`/api/sessions/<id>/` segment. This route *does* have one, so `session=` would
never be consulted here — but naming a *filter* the same thing the guard reads
as a *scope* is a trap for the next person to touch either file. `id=` has no
such overlap.

### `container=` resolution

Both host-visible container-name shapes derive from the same 12-char slice of
the session id:

- `agent-<sessionId.slice(0,12)>` — the session container
  (`container-lifecycle.ts:928`)
- `shipit-<sessionId.slice(0,12)>` — the Compose project for the session's
  services (`compose-cli.ts:90`), so its containers read
  `shipit-<slice>-<service>-<n>` and its volumes `shipit-<slice>_<volume>`

`sessionIdPrefixFromContainerName()` strips a leading `/` (as `docker inspect`
emits) and an `agent-`/`shipit-` prefix, then takes the leading 12 characters of
the remainder and matches `id LIKE '<prefix>%'`. That one rule covers every
shape above, plus a bare id or id prefix pasted straight from the journal.

**The `agent-`/`shipit-` prefix is REQUIRED — a bare name is refused.** A
project's own `docker-compose.yml` may set an explicit `container_name:`, and
ShipIt's generated override does not rewrite it, so a service container can
appear in `docker ps` under any name at all. Reading its leading characters as a
session-id prefix would `LIKE`-match a completely unrelated session — a
*confidently wrong* answer, which on a surface whose whole purpose is to end
guesswork is worse than no answer at all.

An intermediate version accepted a bare *hex-looking* name as an id prefix. That
was not enough: `container_name: deadbeef` on session A still resolved to
session B whose UUID merely started with `deadbeef`. A bare session id simply is
not a container name — it belongs to `--id`, which matches ids against ids and
therefore cannot mis-attribute. So `--container` now takes only what ShipIt
generates, and anything else 400s with both ways forward named: pass a session
id to `--id`, or read the owner off the container's `shipit-parent-session` /
`shipit-session-id` label with `docker inspect`. Turning a dead end into a next
step is the whole point of the feature, so the failure path gets the same
treatment as the success path.

**Residual ambiguity, documented rather than papered over:** a project that sets
`container_name: agent-<12 chars matching another session's UUID prefix>` still
mis-resolves. Nothing in a *name* can distinguish that case — only the label is
authoritative — and the error message is where that fallback is surfaced.

## SessionManager lookups

Straight SQL, no load-all-rows scan (indexes exist on nothing relevant here, but
these are single-digit-millisecond queries against a table of hundreds of rows):

- `findByBranch(branch)` — `WHERE branch = ?`
- `findByIdPrefix(prefix)` — `WHERE id LIKE ? ESCAPE '\'` with `%`/`_`/`\`
  escaped, so a pasted name containing `_` (`shipit-<id>_node_modules`) cannot
  turn into a wildcard.
- `findByPrNumber(n)` — `WHERE json_extract(pr_status,'$.prNumber') = ?
  OR json_extract(previous_merged_pr,'$.number') = ?`. SQLite's JSON1 extension
  ships enabled in the bundled `better-sqlite3` build. Matching
  `previous_merged_pr` too is what makes req 2 hold: the session that opened
  #1741 and then #1744 on `shipit/kmwodw` resolves from either number.
  **Known limit:** `clearMerged` overwrites the single breadcrumb on each
  re-arm, so only the *immediately* preceding PR survives — a branch that
  shipped #1, #2, #3 resolves from #3 and #2 but not #1. Retaining the full
  history means widening docs/202's breadcrumb into a list, which belongs to
  that feature rather than to this read-only lookup; `--branch` covers the older
  ones. The docs say "the one immediately before it", not "any earlier one".

Each returns every matching row including warm/archived ones; the service layer
applies the `includeArchived` and warm filters, so the SQL stays one predicate.

## CLI

```
shipit session find --branch <name> | --pr <number> | --container <name> | --id <id>
                    [--include-archived] [--include-warm] [--limit N] [--offset N] [--json]
shipit session list --all [--include-archived] [--include-warm] [--limit N] [--offset N] [--json]
```

`find` is the headline command — it is what makes the motivating question a
one-step answer. `list --all` is the full inventory; bare `shipit session list`
is untouched and still children-only (req 10). Both are Ops-only and surface the
orchestrator's 403 verbatim (`"Host session inventory is only available in Ops
sessions."`), in the same voice as the `source` shim's refusal. `--json` behaves
like every other subcommand.

`find` requires at least one filter — an unfiltered `find` is `list --all` and
saying so is more useful than dumping the inventory under the wrong verb.

## Rejected alternatives

- **Loosen `api-container-guard.ts`** (cross-session exemption, or make
  `/api/sessions` container-accessible). This is the whole point of *not* doing
  it: the guard's value is that it is default-deny with a golden snapshot test,
  and one exemption for "sessions the caller is allowed to see" turns a
  mechanical check into a judgement call on every future route. Adding an
  Ops-gated route under the caller's own path costs one module and keeps the
  boundary's shape intact.
- **Reuse `GET /api/sessions/:parentId/children` with an Ops bypass.** The
  children route's contract is "descendants of the caller"; bolting a
  kind-conditional "…or everything" onto it makes one endpoint mean two
  different things, and its `ChildSessionView` projection intentionally carries
  `latestAssistantMessage` — conversation content this surface must not emit.
- **A `shipit source`-style read against the SQLite file directly.** The DB is
  not mounted into the Ops container, and mounting it would expose chat history,
  which req 8 forbids.
- **Answer from Docker labels only** (`shipit-session-id` is on every session
  container). That resolves req 3 and nothing else — no branch, no PR, no
  parent, and nothing at all for a session whose container is gone, which is the
  common triage case.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/sessions.ts` | `findByBranch` / `findByPrNumber` / `findByIdPrefix` / `listAllIncludingWarm` |
| `src/server/orchestrator/services/host-sessions.ts` | filter composition + the metadata-only projection |
| `src/server/orchestrator/api-routes-host-sessions.ts` | the Ops-gated route |
| `src/server/orchestrator/api-container-guard.test.ts` | golden route-table snapshot (one new entry) |
| `src/server/session/agent-ops-routes.ts` | `GET /agent-ops/session/host-sessions` relay |
| `src/server/session/agent-shim/shipit-session.ts` | `handleSessionFind`, `list --all` |
| `src/server/session/agent-shim/shipit.ts` | dispatch + `HELP` |
| `src/server/shipit-docs/ops-session.md` | agent-facing Ops contract (fourth pillar) |
| `src/server/orchestrator/templates-ops.ts` | `prompts/trace-a-pr.md` recipe |
