# 183 — Compose service secret isolation: checklist

## Write path (move service env files out of the workspace)
- [ ] `secret-resolver.ts` / `service-secrets-resolver.ts`: write service env files to a
      configurable root (`<stateDir>/service-env/<sessionId>/.env.<service-name>`) instead of
      the workspace `.shipit/.env.<service-name>`.
- [ ] `index.ts`: derive the default `serviceEnvDir` from `SHIPIT_SERVICE_ENV_DIR`, else
      `<stateDir>/service-env`; thread it through to the resolver.
- [ ] Keep the `.shipit/.env.<service-name>` fallback only for tests / no-root injection.
- [ ] Leave `.shipit/.env.agent` (agent-bound values) unchanged.

## Compose override
- [ ] `compose-generator.ts`: accept an optional `serviceEnvFiles?: Record<string, string>`
      and emit absolute `env_file:` paths when present; fall back to
      `.shipit/.env.<service-name>` when absent.
- [ ] `service-manager.ts`: pass the env-file metadata into the override on service start
      and on secret refresh.

## Safety invariant
- [ ] At write time, assert the resolved service-env root does not resolve inside any agent
      workspace mount; refuse to write (rather than silently leak) if it does.

## Docs
- [ ] `src/server/shipit-docs/secrets.md`: document that service-only env files live outside
      the workspace in containerized mode, with Docker-secrets mode as the stronger option.

## Tests
- [ ] `secret-resolver.test.ts`: service env files land under the external root; no
      `.shipit/.env.<service-name>` is created.
- [ ] `compose-generator.test.ts`: override uses supplied absolute env-file paths, falls back
      to `.shipit/.env.<service-name>` when none supplied.
- [ ] `service-manager.test.ts`: service-only secrets written outside the workspace; override
      references the external env file.
- [ ] Regression: dogfood-style service-only secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`)
      with no `agent: true` → `.shipit/.env.dev` absent, external service env file present.

## Rollout
- [ ] Restart active compose stacks via the normal reconcile path so generated overrides
      point at the new file locations.
- [ ] Add an `issue:` pointer to `plan.md` once a tracker item exists.
