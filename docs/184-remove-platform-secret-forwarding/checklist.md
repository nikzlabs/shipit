# 184 — Remove platform credential forwarding: checklist

- [x] Drop the `platformCredentials` resolution branch in `secret-resolver.ts`; fall through
      to `userSecrets[name]` for `source: platform:*` compose entries.
- [x] Add the warn-on-`source: platform:*` notice (service-log broadcast) for compose entries.
- [x] Remove `platformCredentials` parameter threading from `service-secrets-resolver.ts`,
      `service-manager.ts`, `service-manager-setup.ts`, `runner-registry-factory.ts`, `index.ts`.
- [x] Retire `platform-credentials.ts` and `platform-credentials.test.ts` (no remaining consumer).
- [x] `docker-compose.yml`: drop `source:` from the three dogfood `dev` entries, including the
      lingering `source: platform:github_token`.
- [x] `src/server/shipit-docs/secrets.md`: remove the `platform:*` source table + ShipIt-in-ShipIt
      note; document compose services receive only user-supplied secrets.
- [x] Tests: `secret-resolver.test.ts` asserts `source: platform:*` resolves from user secrets
      (or empty) and the warning fires; regression test that a real GitHub token is never injected.
- [x] Confirm the agent MCP OAuth path (`mcpOAuth` → `MCP_PLATFORM_*`) is untouched.
- [ ] Add an `issue:` pointer once a tracker item exists.
