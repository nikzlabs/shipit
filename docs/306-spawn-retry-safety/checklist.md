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
- [ ] Independent review via `shipit agent run --role reviewer`
- [x] Tracker issue created and cross-linked in `plan.md` frontmatter

## Not done here, on purpose

- The six sibling commands in `plan.md`'s audit that also duplicate on retry.
  `shipit agent run` and `shipit session report` are the expensive ones.
- The blind fallback-host retry in `orchestrator-client.ts:70-80`, which turns
  one lost response into a second spawn inside a single invocation whenever
  `SHIPIT_HOST` is not `shipit`. The key added here collapses that duplicate as
  a side effect, but the loop itself is still a blind retry of a non-idempotent
  POST and deserves its own fix.
