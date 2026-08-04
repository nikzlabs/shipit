# Checklist — repo Node version pin

- [x] `requirements.md` written from the issue, open questions asked and answered
      with dated receipts
- [x] `shared/node-pin.ts` — `.nvmrc` / `engines.node` reader + range matcher
- [x] `shared/types/node-runtime-types.ts` — status type both layers read
- [x] `session/node-runtime.ts` — resolve, cache-first lookup, verified download,
      atomic extract, PATH activation, boot singleton
- [x] Worker boot starts provisioning without blocking `listen()`
- [x] `GET /node-runtime` on the worker
- [x] `/install`, `/terminal/start`, `/agent/start` await the pin before spawning
- [x] `runtimeKey()` appends the pinned version (only when pinned)
- [x] Dockerfiles pin the `gh` / `shipit` / `shipit-git-credential` shims to the
      image's Node
- [x] Diagnostics probe + payload field + panel section
- [x] `shipit-docs/environment.md` — agent-facing "Node version" section
- [x] Unit tests: pin parsing, provisioning outcomes, runtime key
- [x] Server test: diagnostics probe degradation
- [x] Client test: panel section states
- [x] `npm run typecheck` + `npm run lint:dev` clean
- [x] Independent fresh-context review against the numbered requirements
