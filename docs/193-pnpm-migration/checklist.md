# 193 — pnpm migration checklist

## Phase 1 — local parity
- [ ] Add `packageManager: "pnpm@<x.y.z>"` (≥ 10.16 for `minimumReleaseAge`)
- [ ] Add `pnpm.overrides` (translate `overrides`; `@fastify/static>brace-expansion`)
- [ ] Add `node-linker=hoisted` (`.npmrc` / `pnpm-workspace.yaml`)
- [ ] Resolve `pnpm.onlyBuiltDependencies` (better-sqlite3, node-pty, esbuild, …)
- [ ] Move `tsx` from `devDependencies` → `dependencies`
- [ ] Delete `package-lock.json`; generate + commit `pnpm-lock.yaml`
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` all green locally

## Phase 2 — CI
- [ ] `ci.yml`: `pnpm/action-setup` + `cache: pnpm` + `pnpm install --frozen-lockfile`
- [ ] Swap `npm run …` → `pnpm …` in both CI jobs
- [ ] `release.yml`: audit + swap npm invocations
- [ ] Confirm a PR runs full suite + `check-deps` + build green

## Phase 3 — Docker / dogfood
- [ ] `Dockerfile.prod`: `pnpm fetch`/`--frozen-lockfile`, `pnpm prune --prod`, store cache mount
- [ ] `Dockerfile.session-worker.prod`: same swap; **leave `/opt/agent-cli` npm block intact**
- [ ] `Dockerfile.dev`, `Dockerfile.dogfood`, `docker-entrypoint.dev.sh`
- [ ] `shipit.yaml`: dogfood `install: pnpm install`
- [ ] Boot a session container — verify node-pty terminal + better-sqlite3 work

## Phase 4 — supply-chain config
- [ ] Set `pnpm.minimumReleaseAge` (7 days) + exclude escape hatch
- [ ] Trim `check-dependency-age.ts` to the pinning check; keep as `pnpm check-deps` in CI
- [ ] Confirm Dependabot still opens cooldown'd, pinned bump PRs against `pnpm-lock.yaml`

## Phase 5 — docs
- [ ] CLAUDE.md (commands + dependency policy section)
- [ ] CONTRIBUTING.md, RELEASING.md, README.md
- [ ] Affected skills (`testing-and-quality`, etc.)
