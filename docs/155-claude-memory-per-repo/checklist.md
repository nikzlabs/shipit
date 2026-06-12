# Per-repo Claude memory sharing — checklist

- [x] `repoMemoryDir` / `REPO_MEMORY_SUBDIR` + copy helpers in `session-credentials.ts`
- [x] `provisionRepoMemory` — first-turn copy-in (Claude + remote URL only)
- [x] `syncMemoryBack` — turn-end copy-back, last-write-wins by mtime
- [x] Wire provision into `prepareSessionAgentEnvironment` step 1 (agent-pin block)
- [x] Wire sync-back into `finalizeSessionAgentEnvironment`
- [x] Disk-janitor GC: `sweepOrphanedRepoMemory` keyed on the repo hash live-set
- [x] Unit tests: session-credentials, session-agent-env, disk-janitor
- [x] typecheck + lint:dev clean
