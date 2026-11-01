# Checklist — spawn retry safety

- [x] `requirements.md` and `plan.md`, with the audit table as req 5
- [x] `spawn-idempotency.ts` — keyed claim, TTL, register-before-await
- [x] `/api/sessions/:parentId/spawn` accepts and honours `idempotencyKey`
- [x] The shim derives the key from title + prompt + target flags
- [x] The shim retries once on a transient status, then reports honestly
- [x] `--detached` points at the sidebar, not at `shipit session list`
- [x] Tests: a repeat with one key spawns once; concurrent repeats spawn once;
      a failed spawn is not replayed as a failure; the key expires
- [x] Tests: the shim's transient path retries once and reports a found session
      rather than a flat failure
- [x] Each new test proved red with the fix removed — the concurrency guard
      against a check-then-await version, the shim guards against the original
      single-call create
- [x] `npm run lint:dev` and `npm run typecheck`
- [x] Independent review via `shipit agent run --role reviewer`
- [x] Tracker issue created and cross-linked in `plan.md` frontmatter

## Review round (2026-09-14)

Three findings, all verified at source and fixed:

- [x] **An expired-but-pending claim could be replaced, and its later failure
      then deleted the newer claim** — a third spawn followed. `evictExpired`
      now skips unsettled claims, and the failure path withdraws only its own
      entry. Two guards added, both proved red against the old shape.
- [x] **A 200 whose body was lost parses to `{}`**, so the create printed an
      empty session id and exited 0. A successful reply must now carry a
      session id or it is reported as uncertain.
- [x] **A refusal on the retry was reported flatly**, discarding the first
      attempt's uncertainty — and the refusal may be *caused* by the session
      that attempt created. The uncertainty now survives.
- [x] **The audit missed `shipit session message`**, whose retry dispatches
      another child turn (`deliveryId: undefined`, `child-sessions.ts:637`).
      The table was rebuilt over the whole non-GET surface.
- [x] **No test proved the route was wired to the claim** — removing
      `spawnClaims.run` left both unit suites green. Two integration tests
      added in `agent-spawned-session.test.ts`; the first goes red when the
      claim is bypassed.

## No second send after the request left (req 6, planning#680)

- [x] `OrchestratorClient` sends a request that is not a read to the next host
      only before the connection is made; after that it reports the failure
- [x] One transport on Node `http` with a connection for each call; the 10 s
      connection limit and the 300 s default limit of the `fetch` path are kept
- [x] Tests against real local servers: a refused connection, a name that gets
      no address, a connection closed after the request, an answer that is cut
      off, a time limit before and after the connection, a `GET`
- [x] Each test proved red with its rule removed
- [x] The double run reproduced over the real relay before the change, and gone
      after it
- [x] `npm run lint:dev` and `npm run typecheck`
- [x] Independent review via `shipit agent run --role reviewer`

### Review round (2026-10-10)

Three findings, all verified at source and fixed:

- [x] **Req 6 and the agent docs promised the rule for a whole command; it
      holds for one request.** `shipit session create` sends its request again
      by design. Req 6 now names that keyed retry as the exception, and
      `environment.md` no longer says that a message means "nothing was done".
- [x] **An IPv6 address in the base URL was looked up as a name**, which the
      `fetch` path did not do. The request now takes the URL itself.
- [x] **The plan said the limits of `fetch` were kept.** They have the same
      numbers and not the same meaning; the plan now says which.
- [x] Test gaps closed: two real time limits of 50 ms and 100 ms could fail on
      a loaded machine (now a fake clock); the failure list with two hosts; a
      refusal with a second host that must not be asked; no timer left after an
      answer; an uncaught exception now fails the file.

## Not done here, on purpose

- The sibling commands in `plan.md`'s audit that also duplicate when the
  command is run again. `shipit agent run` and `shipit session report` are the
  expensive ones.
