# Checklist — secret-scan guard in post-turn auto-commit

- [x] Detector module `secret-scan.ts` (rules, allowlist, redaction, diff scanner)
- [x] Detector unit tests (`secret-scan.test.ts`)
- [x] Scan wired into `GitManager.autoCommit` (block + unstage, `secretFindings` in result)
- [x] Real-git autoCommit guard tests (`git-secret-scan.test.ts`)
- [x] Persisted warning formatter (`secret-scan-notice.ts`) + tests
- [x] Notice surfaced on WS post-turn path (`post-turn.ts`)
- [x] Notice surfaced on dispatched/system-turn fallback + CI-fix path
- [x] `secretFindings` threaded through `SystemTurnDeps.autoCommit` + test mocks
- [x] `typecheck` + `lint:dev` clean, unit tests green
- [x] Design doc + Linear issue (SHI-169) cross-linked
- [x] Review hardening: scan commit messages + file names; guard `commitPaths`; anchor the allowlist
- [x] Guard agent self-commits (moved-HEAD scan before auto-push, ancestor-only to avoid rebase false-blocks)
- [x] `agentCreatePr` aborts on a secret refusal (typed `secretBlocked` from `flushPendingTurnCommit`)
- [x] Use GitHub native secret scanning + push protection as the backstop instead of a custom gitleaks CI job (dropped the workflow + `.gitleaks.toml`)
- [ ] (Settings, not code) Enable Secret scanning + Push protection in the ShipIt repo's Settings → Code security & analysis
