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
      (cross-agent, via `shipit agent run --agent codex`)
- [x] Review follow-ups applied:
  - [x] Login shells (`bash -lc`, which Codex uses for every tool command) lost
        the pinned PATH to Debian's `/etc/profile` — baked profile.d snippet +
        runtime handoff file
  - [x] Overlay base scope split on the repo's pin, so a base of addons built
        under the image's Node is never mounted into a differently-pinned session
  - [x] `/mcp/install` and `/mcp/test` gated on the pin (activation fires them in
        parallel with `agent.install`, not after it)
  - [x] Range parser: accept `">= 20"`, reject `20.x.3` and leading zeros
  - [x] Cache dir requires a real mount, not mere existence (the entrypoint
        always creates `/dep-cache`)
  - [x] Floor rationale corrected against the shipped lockfile (Playwright, not
        the agent CLIs)
  - [x] Requirement 5's Compose cross-check detected and reported

## Known gaps

- Requirement 5 is **partially** satisfied. A repo that pins Node only through
  its Compose image (`image: node:22`, no `.nvmrc`, no `engines.node`) still
  installs under the container's Node; the disagreement is detected and reported
  in diagnostics rather than resolved, because the resolved question fixed the
  pin sources at `.nvmrc` and `engines.node`. Making the Compose image a real
  pin source is a new question for `requirements.md`, not an inference.
- The pin is resolved once at container start. Editing `.nvmrc` mid-session does
  not re-provision; a container restart picks it up.
