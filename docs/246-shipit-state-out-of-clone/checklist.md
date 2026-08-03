# Checklist — ShipIt state out of the session clone

- [ ] `<sessionDir>/state/` in `session-dir-factory.ts` + one exported path helper owning every artifact path
- [ ] Thread the resolved state dir through `service-manager-setup.ts` → `ServiceManager` (docs/183 `serviceEnvDir` pattern) — never derive it from `workspaceDir`
- [ ] `/session-state` mount in `container-lifecycle.ts`; entrypoint chown coverage
- [ ] `compose.override.yml` → state dir, absolute `-f` in `compose-cli.ts`
- [ ] `.install-done` → `/session-state` (install-controller, `preStampInstallMarker`, claim-session)
- [ ] `ci-logs/` → state dir; CI-fix prompt cites the in-container path; drop `ensureShipitGitignored`
- [ ] `.env.agent` → state dir
- [ ] Boot-time sweep of leftover `<clone>/.shipit/` artifacts (working tree only)
- [ ] Guard test: no writer composes `path.join(workspaceDir, ".shipit", …)`
- [ ] Update `shipit-docs/secrets.md` + `shipit-yaml.md` for the new agent-visible paths
- [ ] Fresh-context review of the branch diff against every numbered requirement
