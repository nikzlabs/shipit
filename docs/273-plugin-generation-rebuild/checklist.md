# Checklist

- [x] `requirements.md` from nikzlabs/shipit#2411, in the reporter's terms
- [x] `plan.md` — both defects as diagnosed, and why one identity change answers both
- [x] Generation id: `GenerationRecord.id`, `generationDir` by id, id-aware prune (`GENERATION_ID_RE`)
- [x] Fresh id instead of `still in use` when the deletion lease refuses a rebuild
- [x] `installedFor` on the record + the coverage test in the already-live shortcut
- [x] `plugin-overlay.ts`: work dir + volume name keyed by generation id, bare-commit name unchanged
- [x] `plugin-install.ts`: `PluginInstallJob.generationId` for the layer and the stamp
- [x] `plugin-leases.ts`: `GenerationRef.generationId`
- [x] Service, CLI and compose surfaces mount the id the live record names
- [x] `reinstalled` for any re-activation of the live commit (`plugin-refresh.ts`)
- [x] `--force` help text and `shipit-docs/plugins.md`: not refused while a plugin container holds the version
- [x] docs/262 and docs/266 annotated where this reverses them
- [x] Tests: selection grew, coverage no-op, legacy record untouched, no-runner
      no-loop, rebuild beside a held version, failed rebuild changes nothing,
      rebuild pruned under the lease, volume-name collision, lease identity,
      refresh reports an unforced rebuild
- [x] `npm run lint:dev`, `npm run typecheck`, `npm test` (14734 passed)
- [ ] Independent review (`shipit agent run --role reviewer`)
