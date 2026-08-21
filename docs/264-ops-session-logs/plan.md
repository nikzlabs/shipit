---
issue: planning#374
title: Ops session — read another session's server logs
description: Design for `shipit session logs`, the Ops-gated read of a session's orchestrator-generated log entries.
---

# `shipit session logs` — design

Implements [`requirements.md`](requirements.md). Requirements are cited as
`(req N)`.

## The gap this closes

`broadcastLog` (`app-lifecycle.ts:createLogBuffer`) writes a line to the durable
log store (docs/192) and the in-memory ring. It makes **no console call**. So
every orchestrator event routed through it — auto-push outcomes, compose
reconcile failures, container re-adoption, idle disposal, OOM notices — is
absent from `docker logs shipit-shipit-1` and from the journal.

That is not a small corner. In the incident that opened this work, nine
consecutive auto-pushes were rejected and the host showed the *commits* with no
push and no error after them. The explanation was one line per commit —
`Auto-push rejected: branch has diverged from remote. Rebase needed to update.`,
written by `services/auto-push-scheduler.ts:report` — visible only in the
session's own Logs panel in the browser. From an ops session it looked like a
push that silently vanished.

## Shape

    shipit session logs <session-id> [--since t] [--until t] [--lines N] [--json]

Deliberately the same surface as `shipit session find` / `list --all`
(docs/255), including the Ops gate on the route rather than in the shim (req 2,
req 5).

| Layer | File |
|---|---|
| Service (filter + redaction + resolution) | `orchestrator/services/host-session-logs.ts` |
| Route (Ops gate) | `orchestrator/api-routes-host-sessions.ts` |
| Worker relay (injects the trusted caller id) | `session/agent-ops-routes.ts` |
| Shim (flags + rendering) | `session/agent-shim/shipit-session.ts` |

## The filter is on content, not on the producer

`/shipit-docs/ops-session.md` states that there is no subcommand returning
another session's chat history, prompts, queued messages, assistant output,
secrets, or workspace files, and that none will be added. This change was
weighed against that statement rather than around it — and the first attempt
failed that test.

**What was tried first, and why it was wrong.** The durable agent channel is a
mixed stream: one `agent.jsonl` per session carries the agent CLI's own
stdout/stderr *and* the orchestrator's lifecycle lines. The obvious filter is an
allowlist on `source` — return `"server"`, withhold everything else. That is
what the first implementation did, and an independent review refuted it with a
concrete path:

1. a project's own `docker-compose.yml` holds an invalid value;
2. `compose-generator.ts` quotes that value **verbatim** in a
   `ComposeValidationError` (`device \`${shown}\``, `absolute path \`${file}\``);
3. `service-manager-setup.ts:handleStackError` broadcasts
   `[compose] Stack error: ${err.message}` as source `"server"`.

A project could therefore put arbitrary text — including a short secret — into a
compose value and have it read from another session. `compose-cli.ts` puts raw
`docker compose` stderr into an `Error` the same way, and `agent-listeners.ts`
broadcasts a raw agent/provider `err.message`. `"server"` labels the **producer**;
it says nothing about the **content**.

Worth recording *how* that got shipped: the call sites were audited, and each
one's literal template looked fine. `${err.message}` was read as "an
orchestrator error string" without following it back to where the message is
built. An audit of interpolation sites is only as good as the transitive read
behind every placeholder — which is precisely why the fix is a mechanism that
does not depend on such an audit staying correct.

**What ships instead.** A line is returned only when its WHOLE text matches one
of `OPS_SAFE_TEMPLATES` — anchored patterns ShipIt itself authored, whose only
variable parts are ShipIt-controlled tokens (a count, an exit code, a duration).
Free-text interpolation cannot match one, so a line carrying workspace, agent,
or user content is withheld **by construction** (req 4). `source === "server"`
remains as a cheap first cut so agent stdout that happens to quote one of these
strings can't match either. Both cuts run at the store read (req 3).

Two properties make the table safe to live with:

- **It fails closed.** An unrecognized line is withheld, not passed through. A
  meta-test asserts every pattern is anchored at both ends and contains no
  `.*`/`.+` wildcard, because one wildcard would silently reopen the hole while
  every other test stayed green.
- **It is never silent.** Unmatched server lines are counted into
  `withheldUnclassified` and reported by the CLI. Most are lines that
  legitimately carry workspace or raw error text and never will be returned —
  but the count is also the only signal that a producer's wording drifted off its
  template, so a needed line cannot just stop appearing with nothing to notice.

The cost is real and accepted: an operator who needs a withheld line has to ask
for the session's Logs panel. That is the same answer the boundary already gives
for the conversation, and the docs say so rather than implying the command shows
everything.

## Decisions worth recording

**Read the durable store, never a runner (req 7).** The service takes a
`LogStoreReader` and touches nothing else: no container, no worker round-trip,
no runner registry. A session whose container was destroyed or idle-evicted, or
whose orchestrator has since restarted, still answers — which is the state the
incident was in. The integration test seeds `sessions/<id>/logs/agent.jsonl` by
hand and never creates a runner, so this is asserted rather than assumed.

**Redact with `redactStage1` (req 6) — as defense in depth, not as the
boundary.** The same deterministic Stage-1 floor the bug-report path uses
(docs/164); the Stage-2 LLM pass is deliberately not run, since this is a
synchronous read. It runs *after* the template match, on text that is already
ShipIt's own, and collapses a URL or a long opaque token to `[REDACTED]`.

Worth being explicit, because the first design leaned on it and should not have:
redaction only recognizes known shapes, so it could never have made a free-text
line safe to cross a session boundary. A short secret pasted into a compose value
has no recognizable shape at all. The template table is what holds requirement 4;
this is a second layer behind it.

**`logsRetained`, so absence is never misread.** A session's logs are removed on
archive / delete / full reset. An empty window and a pruned history render
identically otherwise, and they mean opposite things — one says nothing
happened, the other says the evidence is gone. The response carries the
distinction and the shim prints it in words.

**Read the FULL retained window, not the default one.** `LogStore` keeps two
generations per channel (active + `.1`, 1 MB each) but `snapshotEntries`
defaults to reading only *one* — right for seeding a viewer, wrong for a reader
that filters. A first version took that default and would have hidden server
lines that were still on disk behind a megabyte of agent stdout, reporting a
confident "no auto-push failures in this window" while the evidence sat in the
rotated file. `snapshotEntries` now takes an explicit `maxBytes` and this
service passes `MAX_RETAINED_CHANNEL_BYTES`. A unit test seeds the server line
into the rotated generation only, so a regression to the default returns nothing
and fails.

Beyond that window the tail really is gone — the channel is bounded and shared
with agent stdout, so a chatty session can push its own older server lines out of
retention. Nothing here can recover them, so the ops doc says plainly that a
quiet distant past on a busy session means "not retained", not "nothing
happened". Raising the retention is a docs/192 change, not this one.

**Reject a bound that was never applied, don't ignore it.** A silently-dropped
`--since` returns the whole history dressed as the window the operator asked
for, and an operator reading "nothing in the last 10 minutes" off a full-history
dump draws exactly the wrong conclusion. Bounds accept strict ISO-8601 (not
whatever `Date.parse` happens to take, so the enforced contract matches the
documented one) or a relative age (`90s`/`30m`/`2h`/`3d`); anything else is a
400, as is a `--lines` that isn't a positive integer. Clamping `--lines` DOWN
from a too-large value stays silent — `truncated` and `total` already report it.

**Resolve a truncated id prefix, refuse an ambiguous one.** The operator's input
is usually a short id from a journal line, so `find`-style prefix resolution
saves a round-trip. Two matches is an error, never a pick — a confidently wrong
attribution is the failure mode the whole ops surface exists to remove.

**`target=`, not `session=`.** The route lives under the *caller's* own session
path so `api-container-guard.ts`'s §3 own-session scope check passes unchanged;
the session being read is a query param. `session=` is what the guard reads as a
scope when a path carries no session segment, so naming a filter that would be a
trap for whoever edits either file next — the sibling route calls its filter
`id=` for the same reason.

## Discoverability (req 8)

An ops session that does not know the subcommand exists gets no value from it,
and the corollary — *the orchestrator log is not the whole story* — is the part
that actually changes a triage. So it is stated in four places: the capability
bullet and the boundary paragraph in `/shipit-docs/ops-session.md`, the
subcommand row in `/shipit-docs/sessions.md`, the ops workspace README, and a
new paste-and-go recipe `prompts/read-session-logs.md`. The two host-facing
recipes (`trace-a-pr`, `diagnose-stuck-session`) now run it *before* reaching for
`docker logs`, so the ordering is in the recipe rather than only in prose.

## Out of scope

The auto-push silence itself. `report()` should arguably also write to the
console, but that is a separate change with its own diagnosis, and the incident
packet scoped it out. This is the read capability only.

## Key files

- `src/server/orchestrator/services/host-session-logs.ts` — the filter,
  redaction, target resolution, and time/line bounds. Read its docstring first.
- `src/server/orchestrator/api-routes-host-sessions.ts` — both Ops routes and
  the shared `requireOpsSession` gate.
- `src/server/session/agent-shim/shipit-session.ts` — `handleSessionLogs`.
- `src/server/orchestrator/templates-ops.ts` — the ops workspace README and
  `prompts/read-session-logs.md`.
- `src/server/orchestrator/services/host-session-logs.test.ts`,
  `src/server/orchestrator/integration_tests/ops-session-logs.test.ts` — the
  content and source filters, the kind gate, and the container-is-gone case
  (req 9). `withholds a server line that quotes workspace content` is the
  regression test for the defect described above; do not delete it.
- `src/server/orchestrator/log-store.ts` — `MAX_RETAINED_CHANNEL_BYTES` and the
  `maxBytes` parameter on `snapshotEntries`.
