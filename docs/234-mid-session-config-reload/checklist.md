# Mid-session config reload — Checklist

- [x] `ServiceManager.updateComposeConfig()` + `ComposeCli.setComposeFile()` — adopt a new `compose:` block
- [x] `applyShipitConfigChange()` in `service-manager-setup.ts` (compose path/socket, install delta, compose added/removed, parse-error safety)
- [x] Gate the compose-removal teardown on a trustworthy `shipit.yaml` read (missing ≠ unreadable)
- [x] Extract `ServiceSetupDeps` so setup and the change applier share one dependency shape
- [x] `ContainerSessionRunner.reevaluateWorkspaceConfig()` + `appliedInstallCommands` + `requestDepReinstall()`
- [x] Record `agent.install` commands even when the list is empty (diff basis)
- [x] Wire `onComposeConfigChanged` → `applyShipitConfigChange` in the runner registry
- [x] Call the re-evaluation from `runRebaseFlow` (clean + conflicts-resolved paths only)
- [x] Call the re-evaluation from the rollback route
- [x] Re-issue `/files/watch` on every SSE open so a dead watcher self-heals
- [x] Unit tests for the config-delta paths (`service-manager-setup.test.ts`)
- [x] Rebase-driver tests: re-evaluates after a real rebase, not on `up_to_date`
