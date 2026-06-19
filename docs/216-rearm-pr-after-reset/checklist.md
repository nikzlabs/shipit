# Checklist — re-arm after branch reset to clean base

- [x] `GitManager.headIsAtBase(base)` detection (HEAD === origin/<base> tip)
- [x] `detectAndReArmResetSession` helper (clearMerged → reArm → session_list → clean ready card)
- [x] `SystemTurnDeps.postTurnReArmReset` every-turn hook type
- [x] `turn-executor.ts` calls the hook regardless of commit
- [x] Wire on both post-turn sites (WS handler + dispatch/system-turn)
- [x] Unit tests: `git-rearm-detect.test.ts` (`headIsAtBase`) + `pr-rearm.test.ts` (`detectAndReArmResetSession`)
- [x] typecheck + lint:dev clean
