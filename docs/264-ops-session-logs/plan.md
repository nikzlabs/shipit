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

## Why this is not the boundary it looks like

`/shipit-docs/ops-session.md` states that there is no subcommand returning
another session's chat history, prompts, queued messages, assistant output,
secrets, or workspace files, and that none will be added. This change was
weighed against that statement rather than around it.

The durable agent channel is a **mixed stream**: one `agent.jsonl` per session
carries the agent CLI's own stdout/stderr *and* the orchestrator's lifecycle
lines. A subcommand that returned "the session's logs" would plainly cross the
boundary. What ships instead is an **allowlist on `source`** applied where the
store is read (req 3): `SERVER_LOG_SOURCES = {"server"}`, and everything else —
`stdout`, `stderr` (agent output), `preview` (the user's app), `install` (the
workspace), and any source that is missing, mis-cased, or added later — is
withheld (req 4). Server-source lines are orchestrator-generated text, the same
category as the orchestrator's own stdout, merely routed per session. The
boundary as written is untouched: the conversation is still unreachable.

The filter is a membership test, so it fails closed. `host-session-logs.test.ts`
sweeps every member of the `LogSource` union and asserts that only `server`
survives — adding a source to that union without deciding about it fails the
build.

## Decisions worth recording

**Read the durable store, never a runner (req 7).** The service takes a
`LogStoreReader` and touches nothing else: no container, no worker round-trip,
no runner registry. A session whose container was destroyed or idle-evicted, or
whose orchestrator has since restarted, still answers — which is the state the
incident was in. The integration test seeds `sessions/<id>/logs/agent.jsonl` by
hand and never creates a runner, so this is asserted rather than assumed.

**Redact with `redactStage1` (req 6).** The same deterministic Stage-1 floor the
bug-report path uses (docs/164), and the Stage-2 LLM pass is deliberately not
run — this is a synchronous read. It costs readability: a URL or a 40+ character
token collapses to `[REDACTED]`. That is the right trade at a session boundary,
because `Auto-push failed: ${errMsg}` carries git's own stderr verbatim and a
push failure is exactly where a credentialed remote URL appears. Identifiers
should come from `shipit session find`, not from log prose.

**`logsRetained`, so absence is never misread.** A session's logs are removed on
archive / delete / full reset. An empty window and a pruned history render
identically otherwise, and they mean opposite things — one says nothing
happened, the other says the evidence is gone. The response carries the
distinction and the shim prints it in words.

**Known limitation, documented rather than papered over.** The channel keeps a
bounded tail (`LogStore` rotates at 1 MB and a snapshot reads at most the last
1 MB), and it is a *mixed* stream — so a session whose agent wrote a lot of
output can push its own older server lines out of retention. Nothing here can
recover them, so the ops doc says plainly that a quiet distant past on a busy
session means "not retained", not "nothing happened". Raising the retention is a
docs/192 change, not this one.

**Reject an unparseable `--since`, don't ignore it.** A silently-dropped bound
returns the whole history dressed as the window the operator asked for, and an
operator reading "nothing in the last 10 minutes" off a full-history dump draws
exactly the wrong conclusion. Bounds accept ISO-8601 or a relative age
(`90s`/`30m`/`2h`/`3d`); anything else is a 400.

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
  source filter, the kind gate, and the container-is-gone case (req 9).
