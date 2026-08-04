# Checklist

- [x] `PLACEHOLDER_WORKER_URL` + `WorkerUnavailableError` in `worker-http.ts`
- [x] Placeholder guard on `workerPost` / `workerPut` / `workerGet` (rejects, never throws synchronously)
- [x] `ContainerSessionRunner.awaitingContainer` + `markWorkerUnavailable` + `assertWorkerReachable`
- [x] Guard `_doStartAgentViaProxy` and `runInstall` after their `_workerReady` await
- [x] Optional `awaitingContainer` on `SessionRunnerInterface`
- [x] Bounded create-retry loop with backoff and deterministic-failure exclusions
- [x] Record the creation error on the runner before the terminal dispose
- [x] `createMissingContainerReconciler` skips runners awaiting their container
- [x] Tests: retry recovery, budget exhaustion, no-retry-on-deterministic, reconciler skip vs. genuine orphan, error legibility
- [x] `npm run lint:dev` + `npm run typecheck` clean
