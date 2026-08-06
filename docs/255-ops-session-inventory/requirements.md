# Requirements — Ops session inventory lookup

What an **Ops session** must be able to answer about the sessions running on the
host it is debugging. Written from the operator's report of 2026-08-06 (below);
the mechanism lives in [`plan.md`](plan.md).

## Motivating incident

An operator asked an Ops session: *"what session created
<https://github.com/nikzlabs/shipit/pull/1744>?"*

The Ops agent got as far as PR #1744 → head branch `shipit/kmwodw` → the same
branch also carried PR #1741 → therefore one session, spawned by Ops session
`84ac5cf7-701f-4ae7-b02f-50c6d5bca1a6`. Then it dead-ended. It narrowed the
answer to **two candidate session UUIDs** by correlating `sbJoin`/teardown
timestamps and `shipit-<id>-web-1` container names in the host journal against
the PR's CI timestamps — and could not choose between them. The answer was in
the orchestrator's `sessions` table the whole time.

## Requirements

1. From an Ops session, an operator can go from a **branch name** to the session
   that owns it, in one command, without correlating journal timestamps.
2. From an Ops session, an operator can go from a **PR number** to the session
   that opened it, in one command. This must work for a PR the session has since
   superseded (branch `shipit/kmwodw` carried #1741 *and* #1744; both must
   resolve to that session).
3. From an Ops session, an operator can go from a **container name** as it
   appears in `docker ps` or the host journal (`agent-83292266-744`,
   `shipit-83292266-744-web-1`) to the session that container belongs to.
4. From an Ops session, an operator can go from a **session id** — including a
   truncated one — to that session's record.
5. An Ops session can list **every** session on the host, not only the ones it
   spawned itself. Today `shipit session list` returns `[]` for an Ops session,
   because it is scoped to children.
6. The answer identifies the session well enough to act on it: at minimum its id,
   title, kind, branch, repository, who spawned it, and its PR.
7. Archived / evicted sessions are reachable too — a triage question usually
   arrives *after* the session is done — but they do not clutter the default
   answer.
8. An Ops session must **not** be able to read what was said inside another
   session: no conversation replay, no prompts, no queued messages, no assistant
   message bodies, no secrets, tokens, env, or workspace contents. It sees *that*
   a session exists and what it owns, never its contents.
9. This capability is Ops-only. An ordinary session asking the same question is
   refused, and the refusal says why.
10. No existing behaviour changes. In particular `shipit session list` with no
    new flag still returns only the caller's own children, and the
    container↔orchestrator trust boundary keeps its current shape.

## Open questions

_(none)_

## Resolved questions

**2026-08-06 — Is the metadata-only boundary the right cut, or should an Ops
session be able to read another session's transcript?**
Answered in the incident packet by the operator/Ops session that requested this
work: *"An ops session should be able to see that a session exists and what it
owns — not read what the user said in it."* Recorded as req 8.

**2026-08-06 — Should the container trust boundary be loosened (make
`/api/sessions` container-accessible, or add a cross-session exemption to
`api-container-guard.ts`) so an Ops session can just read the session list?**
Answered in the same packet: no — *"Do not add a cross-session exemption to
`api-container-guard.ts`, do not touch `HARD_DENY_PREFIXES`, and do not make
`/api/sessions` container-accessible."* Recorded as req 10 and as the rejected
alternative in `plan.md`.
