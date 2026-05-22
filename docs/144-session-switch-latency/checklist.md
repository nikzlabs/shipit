# Checklist — session-switch latency

## Investigation (done)

- [x] Trace the end-to-end new-session / switch flow (client + server)
- [x] Identify the dominant bottleneck (two serial GitHub fetches on the claim path)
- [x] Answer the code-path-unification question
- [x] Add timing instrumentation (`[timing]` logs, server + client)

## Quick wins (no measurement needed — ship as a batch)

- [x] **Fix #1** — make the next-session re-warm fire-and-forget (don't `await`
      `warmSessionForRepo` in the claim handler)
  - [x] `void` the re-warm on the `warm` / `waiting` / `slow-clone` sub-paths
  - [x] Verify pool/standby tracking is unaffected (`setWarmSessionId`,
        `createStandby`, `warmingPromises.set` all run inside the promise body;
        concurrency held by each claim's leading `await waitForWarmSession`)
  - [x] Test: rapid concurrent claims each yield a usable session; claim →
        graduate → claim yields a fresh distinct session (warm-sessions.test.ts)
- [x] **Fix #2** — fix the silent message drop on first send
  - [x] Producer revived: `handleSend` stashes the message as `pendingWsMessage`
        when `status !== "open"` instead of calling `send()` (which drops);
        `useConnectionSync` flushes it on WS open
  - [x] Test: `useConnectionSync` flushes the pending message on open and clears
        it; holds it while connecting (useConnectionSync.test.ts)
- [x] **Fix #3** — collapsed the reuse / warm / waiting refresh blocks into one
      `refreshClaimedSession` helper + a `rewarmPool` helper (re-warm stays the
      caller's concern — reuse must not, warm/waiting/slow do)
- [x] **Fix #4** — updated `session-lifecycle` / `session-containers` skills to
      reflect standby containers (factory cases incl. `claimStandby`, the
      `withStandby` re-warm, and which warms are container-less)

## Measure, then decide

- [x] Deploy the quick wins; collect `[timing] claim-session ... fetch=<ms>`
      from real traffic — dogfooded 2026-05-22, see "Measured results" in plan.md
- [x] Decide whether the residual git fetch #1 justifies building the proactive
      pre-fetch feature → **yes** (fetch is ~95–98% of claim latency, ~650ms,
      every path). Gate cleared → [docs/145-proactive-git-prefetch/](../145-proactive-git-prefetch/plan.md)
