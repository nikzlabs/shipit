# Base-branch push protection — checklist

- [x] Reproduce the incident's shape in a test (stale clone → force-push → base branch rewinds)
- [x] Refuse a rewinding force-push in `GitManager.forcePushWithLease`
- [x] Fetch the remote tip when it is not a local object, and refuse if it stays unreadable
- [x] Add `findSharedBranchRefusal` and wire it into `quickCreatePr` / `agentCreatePr`
- [x] Treat an unrecorded session branch as a wrong-branch refusal in `checkResetPreconditions`
- [x] Give `tryForcePush` the base-branch refusal `pushIfAheadOfRemote` already had
- [x] Correct the stale detached-HEAD comment in `pushIfAheadOfRemote`
- [x] Block `git checkout <branch>` alongside `git switch <branch>` in the hook
- [x] Catch `git push origin +<ref>` under the destructive guard
- [x] Guard tests for all of the above
- [x] Independent review
