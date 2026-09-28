# Checklist — 318 Compose remaining file escapes

## Design

- [x] Verify all four escapes still hold in current code (post-planning#619)
- [x] Write requirements.md; resolve open questions with the requester (Q1–Q10)
- [x] Write plan.md
- [x] Sync tracker (comments on planning#620)
- [x] Review rounds 1–6; findings applied or escalated (plan.md *Design history*)
- [x] Redesign around the confined Compose container (requirements Q8)
- [x] Review rounds 7–28 on the redesign; findings applied, or escalated as Q9 and Q10
- [x] Review until no important findings remain (round 29: none)
- [x] Record the threat model as requirement 7; resolve Q12–Q14 (requirement 8) and design the answer
- [ ] Review the requirement 7 and 8 design until no important findings remain
- [ ] Get go-ahead on the plan (large, daemon-unverifiable change)

## Mechanism 1 — confined Compose containers

- [ ] Minimal Compose helper image (base system plus the orchestrator's Docker packages) as a Dockerfile target, a service in each deployment's Compose definition, and in the image lists of `docker/local/dev.sh`, `docker/local/prod.sh`, `deployment/local/lib.sh`, `deployment/vps/deploy.sh`
- [ ] Pin one checked `docker-compose-plugin` version (not 2.34.0) in `docker/Dockerfile.prod`, `docker/Dockerfile.dev`, and the helper image
- [ ] Resolve the helper image at startup; refuse a start with a clear message when it is missing or a container cannot start
- [ ] Run `config`, project-file reads, secret/config file reads, `build`, and `up --no-build` in confined containers with the per-command mounts in plan.md: mounts at orchestrator paths, `--network none`, read-only root with tmpfs `/tmp`, `no-new-privileges`, `composeSpawnEnv` only
- [ ] `config`, file reads, and `build` mount this session's workspace and scratch (`<sessionDir>/scratch`) and no ShipIt file; their ShipIt input comes on stdin (`-f -`); they run as the session identity (plus the socket group for `build`)
- [ ] `up --no-build` runs as root with the snapshot and `compose/`, the service-env files, and the registry login; no workspace
- [ ] Bind-mount every ShipIt file from its Docker-host path (`workspaceVolumeDaemonPath`); a `SHIPIT_SERVICE_ENV_DIR` outside the workspace volume needs a supplied host path, else refuse with a message naming the setting
- [ ] Registry login copied as `config.json` into one root-only directory in the workspace volume (outside session dirs) before each `up`; `DOCKER_CONFIG` = that directory
- [ ] Environment: `config` keeps today's values (incl. `HOME`); `build` gets `HOME`, `DOCKER_CONFIG`, `BUILDX_CONFIG` on the tmpfs; working directory = the workspace (`compose/` for `up`)
- [ ] Unique name and `shipit-compose-helper` label; remove by name on cancel or timeout; startup janitor sweep
- [ ] Failure messages: the fix appended to path-read failures; a registry-auth build failure names the requirement 6 exception
- [ ] `build` every time for the services `up` starts (replaces today's `--build`); `up` always `--no-build`
- [ ] Orchestrator-side `docker compose ps`, `logs`, and the final `down` with `-p <project>`, no model file, and an empty ShipIt working directory with no Compose file names above it; plain `docker rm`/`inspect`/`network rm` calls unchanged
- [ ] Orchestrator-side `stop` with the start's own snapshot and override, found in ShipIt's root-only record of which start last started each service (no container label); keep the pair while such a service runs; no container → record the Stop only; pair gone → model-free stop, logged; `down` stops each running service that way first
- [ ] Volume teardown: the final model-free `down` keeps `--volumes` (else `docker rm -fv` first), then remove the volumes that carry this project's Compose label, by name

## Mechanism 2 — resolve once, validate, rewrite, start from that file

- [ ] Confined `config --no-consistency <the project services this start names>` with the plugin stubs on stdin, returning the raw bytes too; a start with no project service skips resolve; stub services dropped from the resolved model
- [ ] Every reader of the project file (`parseProjectCompose`, `assertProjectComposeStillValid`, reconcile, `parseUserNamedVolumes`, `readProjectServices`, `collectPluginFragmentIssues`) parses raw bytes from a confined read made for that operation; no orchestrator-side read, no reuse of earlier bytes; the service map stays on the raw bytes
- [ ] Syntax checks on the raw bytes; security checks once, on the resolved model (accept only Compose's own normalization)
- [ ] Rules in every mode: `provider` refused; shared namespaces (`pid`, `ipc`, `network_mode`, `uts`, `cgroup`, `userns_mode`) refuse `host` and `container:<name>`; binds inside the workspace or refused, with today's socket allowance matched exactly; named volumes declared (with the `persist` / `persist/<sub>` exemption); `volumes_from` service-only; top-level `secrets`/`configs` `file:` inside the workspace, `external` and `name` refused; anything unresolved refused
- [ ] Refuse, never drop, an `env_file` that `config` did not inline
- [ ] Rewrite: `rewriteVolumes` on absolute sources, recording each bind's workspace-relative path for `overlayMountsForService`; ShipIt volume declarations beside the mounts; project secret/config files copied through a confined container into `state/compose/secrets/`; inlined `env_file`/`label_file` keys removed; the override stops rewriting volumes and moves into `compose/`
- [ ] One snapshot per start in `<state>/compose/`, never changed after writing, `$` escaped; build model (snapshot + stubs, `build.secrets` at workspace paths) on stdin to `build`; per-start override for exactly the snapshot's services plus admitted plugins, with `pull_policy: never` on built services
- [ ] `up` without `--remove-orphans`; ShipIt removes orphan containers by name before `up`
- [ ] In `withUpInFlight`: the start adds its promise to `upSettled`, then awaits the resolve before the in-flight count, then skips `build`/`up` if `stoppedByUser` holds the service
- [ ] Reconcile: fresh confined read for the service map, then `start()` through the full sequence; plugin-only stacks keep the override-only path

## Requirements 7 and 8 — settings that reach the host

- [ ] Open-session `cap_add` only from `SAFE_ADDED_CAPABILITIES` (prefix stripped, uppercased); contained sessions keep refusing all
- [ ] `security_opt` only `no-new-privileges` in every mode
- [ ] `validateBuildSecurity` in every mode, with mode-neutral messages
- [ ] Socket mount and `use_api_socket` only with `compose.docker-socket: true` and the repository's `allowDockerSocket` grant, read at each start; refusal names the setting
- [ ] Ops sessions without the grant: only the trusted proxy's read-only mount, in every mode
- [ ] `allowDockerSocket` setting: `repos.allow_docker_socket` column and migration, `RepoInfo`, `PATCH /api/repos/:url` through `applyRepoSettings`, reader and `::set` operation, `project.allowDockerSocket` catalogue entry, client store and toggle

## Finish

- [ ] Tests: `docker run` arguments per command and cleanup, resolved-model validation over recorded `config` output, rewrite, secret-file copy, file-key removal, stop record, plugin-only path, fail-closed paths
- [ ] Docs: `shipit-docs/compose.md`, `shipit-docs/wiki/repos-and-sandboxes.md`, `docs/172-agent-containment/plan.md`, `docs/086-shipit-yaml-and-compose/plan.md`
- [ ] `npm run lint:dev`, `npm run typecheck`, affected `npx vitest run`
- [ ] Independent review (`shipit agent run --role reviewer`) of the implementation against every requirement
- [ ] PR test plan lists the deployment checks from plan.md
