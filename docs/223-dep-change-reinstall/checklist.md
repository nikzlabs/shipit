# Checklist — Dependency-change auto-reinstall (#1622)

- [x] Push install commands + resolved dep-input set to the runner (`service-manager-setup.ts`)
- [x] Detect dep-input changes in the `file_changes` handler (`isDepInputChange`)
- [x] Bracketed mid-session reinstall reusing `setInstallRunning` + `runInstall`
- [x] 30s cooldown throttle with trailing-edge coalescing
- [x] Clear the throttle timer on dispose
- [x] Co-located unit tests (predicate + throttle)
- [x] Update agent-facing docs (environment.md, preview.md)
- [ ] Extend the install-gate integration test (CI-run; OOMs in-session)
