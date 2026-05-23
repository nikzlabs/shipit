# Checklist — Fast `npm install`

## v1 scope (worker-side, Option A + Option E flag tuning)

- [x] Add `nm-store` constant + container mount path (`/dep-cache/nm-store`, sits inside the existing `/dep-cache` mount — no new Docker mount needed)
- [x] Worker: `isCacheableInstall(cmd)` — accepts only single bare `npm ci|install`, `yarn [install]`, `pnpm install`, no chaining
- [x] Worker: `computeStoreKey({ lockfile, runtimeKey, installCommand })` — sha256 over lockfile name + content + runtime + tuned command
- [x] Worker: `runtimeKey()` from `SESSION_WORKER_IMAGE_ID`/`IMAGE_DIGEST` env + arch + libc + node major
- [x] Worker: `tuneNpmInstall(cmd)` injects `--prefer-offline --no-audit --no-fund` (Option E)
- [x] Worker: `findLockfile(workspaceDir)` — picks package-lock.json | yarn.lock | pnpm-lock.yaml, returns null if 0 or >1 (workspace/monorepo fall-through)
- [x] Worker: `materialize(storeDir, destDir)` — copy ladder: tar-stream → cp -a → caller falls back to real install
- [x] Worker: `populateStore(srcDir, storeDir)` — temp-dir + atomic rename, single-flight across processes via the rename race
- [x] Worker: `runInstallCommands` — fast-path branch (lookup → materialize → marker) and populate-on-real-install side effect
- [x] Kill-switch env var `SHIPIT_FAST_INSTALL=disabled` forces today's plain install
- [x] Test override env var `SHIPIT_NM_STORE_DIR` so unit/integration tests can point at a temp dir
- [x] Disk janitor: prune `nm-store/<storeKey>` directories older than `DISK_JANITOR_NM_STORE_DAYS` (default 14)
- [x] Tests: storeKey stability + invalidation matrix
- [x] Tests: isCacheableInstall accept/reject matrix
- [x] Tests: tuneNpmInstall (npm-only, bare-only)
- [x] Tests: findLockfile (single, none, multi, re-hash on edit)
- [x] Tests: materialize ladder (tar success, independent copy, clears partials, missing-store error)
- [x] Tests: populateStore (publish, no-op on existing, concurrent populates serialize)
- [x] Tests: disk janitor nm-store sweep (mtime cutoff, skip .tmp-, disabled when days<=0)
- [x] Integration test: worker fast-path hit materializes without invoking npm
- [x] Integration test: kill-switch bypasses the cache

## Out of scope (deferred)

- Warm-pool composes-with-A: `runPreInstall` already populates `.shipit/.install-done`, and the populate-on-real-install path warms the store for free. No code change needed.
- Reflink ladder rung (`cp --reflink=always`): prod is ext4. Add it as a rung above tar when an xfs(reflink)/btrfs host appears.
- Option D (container-creation-time overlay): only if tar-copy proves to be the bottleneck after v1.
- pnpm dogfooding (Option B): documentation-only.
- Monorepo/multi-lockfile coverage: v1 falls through to real install when 0 or >1 lockfile detected.
- `--timing` instrumentation pass — defer; the fast-path hit case is already an order of magnitude faster, no measurement required to prove that.

## After ship

- [x] Update `docs/148-fast-npm-install/plan.md` status `planned → in-progress` while wiring
- [x] Keep ShipIt's own `shipit.yaml` on bare `npm install` so the worker fast path can engage
- [x] On merge, flip to `done` and check off the items above
