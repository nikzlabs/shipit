---
issue: planning#374
title: Ops session — read another session's server logs
description: A read-only `shipit session logs` subcommand that returns server-source log entries for any session on the host, gated on ops sessions.
---

# Requirements — `shipit session logs` (Ops)

These come from the incident packet that opened this work: an ops session
(docs/128) diagnosed nine consecutive rejected auto-pushes on session
`7bc72326…`, and the decisive evidence — one `Auto-push rejected: branch has
diverged from remote.` line per commit — was NOT reachable from the ops session.
`broadcastLog` writes only to the durable log store and the in-memory ring, so
the whole class of auto-push failures is invisible to `docker logs
shipit-shipit-1`. The operator had to read the line out of the browser UI by
hand and paste it into chat.

## Requirements

1. An ops session can read another session's **server-source** log entries from
   its own shell, without a human copying them out of the browser UI.
2. The subcommand matches the existing `shipit session find` / `list` surface:
   `shipit session logs <session-id> [--since <t>] [--until <t>] [--lines N]
   [--json]`.
3. Only entries whose `source` is the server/orchestrator kind are returned, and
   the filter is applied **at the store read**, not in the renderer.
4. Agent output, user messages, assistant text, prompts, queued messages, and
   anything from the workspace are never returned — by any flag, in any mode.
5. The subcommand is gated on `kind: "ops"`, exactly as the rest of the ops
   surface is. An ordinary session must not gain it.
6. Output is redacted the same way the rest of the ops surface redacts.
7. It reads the durable log store (docs/192), so it works for a session whose
   container is already gone.
8. A future ops session learns the subcommand exists — and that the
   orchestrator's own log is not the whole story — from `/shipit-docs/
   ops-session.md` and from the `prompts/` recipes seeded into every ops
   workspace (`templates-ops.ts`).
9. Tests cover the kind gate, the source filter (a non-server entry can never
   appear in the output), and the container-is-gone case.

These come from a second incident packet (2026-09-02): an operator running an
ops session could not answer "did the last five agent turns produce any
commits?" from `shipit session logs`. The window returned 67 agent-start/exit
lines, reported `384 server line(s)` withheld, and said nothing about any push.

10. An ops session can tell a **successful** push from silence. A push that
    landed, and a push that had nothing to send, each produce a line the ops
    read returns — so an absence of failure lines is no longer the only
    evidence that pushing is working.
11. The withheld count is reported **broken down**, so an operator can tell one
    chatty producer from a real signal and a maintainer can tell which template
    to write next. The breakdown carries ShipIt-authored labels and counts
    only; no part of a withheld line appears in it.
12. Lines whose text is entirely ShipIt-authored are returned. Where a producer
    mixes authored text with interpolated detail, the fix is at the producer —
    split the line, or give it a structured field — never a widened pattern.

## Non-requirements

- Fixing the auto-push silence itself. The incident packet scopes that out
  explicitly: it is a separate change with its own diagnosis. This work is the
  read capability only.
- Any widening of the "no reading another session's conversation" boundary
  stated in `/shipit-docs/ops-session.md`. See `plan.md` § *Why this is not the
  boundary it looks like*.

## Open questions

None. The packet specified the subcommand shape, the source filter, the gate,
the redaction posture, and the doc updates.

## Resolved questions

- **2026-08-15 — what counts as "the server/orchestrator kind"?** Answered by
  requirement 3 read against the code rather than by a new question:
  `LogSource` is `"stderr" | "stdout" | "server" | "preview" | "install"`, and
  only `"server"` is orchestrator-generated. `stdout`/`stderr` are the agent
  CLI's own streams (requirement 4 forbids them), `preview` is error text posted
  by the user's running app, and `install` is the workspace's install command
  output. The source allowlist is therefore exactly `{"server"}`.

- **2026-08-15 — a source allowlist does not satisfy requirement 4, so the
  filter moved to the content.** The first implementation filtered on
  `source === "server"` alone. An independent review (`shipit agent run --role
  reviewer`) showed that violates requirement 4 with a concrete path: a value in
  a project's own `docker-compose.yml` is quoted verbatim by
  `compose-generator.ts` into a `ComposeValidationError`, which
  `service-manager-setup.ts:handleStackError` broadcasts as a `"server"` line —
  so a project could put arbitrary text into a compose value and have it read
  from another session. Verified at those two files before acting on it.

  Requirements 3 and 4 are unchanged; the *design* changed to satisfy both. The
  source cut stays as a first pass, and the boundary is now a full-line template
  allowlist (`plan.md` § *The filter is on content*). Requirement 3's "filter at
  the store read" still holds — both cuts happen there.
