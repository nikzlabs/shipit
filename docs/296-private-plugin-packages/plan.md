---
title: Private npm package sources for ShipIt plugins
description: Add authenticated package acquisition to the existing plugin generation and activation flow.
---

# Private plugin packages

Design proposal only. Defines support for the outcomes in
[requirements.md](./requirements.md); no runtime support is added by this PR.

See the [distribution diagram](./distribution.svg) for the two paths.

## Decision

Add npm release packages as a second external plugin source. Keep Git sources
and `repo: self` for development. Resolve and download packages in the
orchestrator, then pass their verified files through the existing staged
installation and activation flow. The author controls release contents with
standard npm packaging. ShipIt does not infer which files are examples.

The first implementation supports exact versions, one SHA-512 archive checksum
per declaration, and HTTPS registries with bearer-token authentication. It does
not add version ranges, mutable dist-tags, automatic upgrades, a registry
server, or a new publishing engine. These are scope decisions, not limitations
of npm. Registry selection remains portable, including a self-hosted service.

## Current behavior and corrected premise

The standard orchestrator images already run `git lfs install --system
--skip-repo --skip-smudge` (`docker/Dockerfile.prod`, `.dev`, and `.dogfood`).
`plugin-generations.ts:checkoutCommit` checks out from a bare cache and does
not explicitly materialize LFS content. Therefore normal Git plugin acquisition
already leaves LFS pointers. A plugin-authored install or another download path
can still fetch assets; this design does not diagnose the reported download.
Earlier conversational advice missed the image configuration.

The release-package benefit is broader: exclude ordinary development files and
Git history, control the runnable distribution, and let consumers read a private
package without access to the private source repository. A runtime tool reading
an LFS pointer already fails unless another step materializes it. The package
contract below makes the author responsible for including real runtime assets.

## User flow and declaration

The agent configures a package when the user asks to use it. The project records
the package URL components and version; the token stays in Settings. A fresh
session does not need a terminal command or a local Git override.

Proposed `shipit.yaml` syntax (not accepted by ShipIt yet):

```yaml
plugins:
  packages:
    - name: asset-tools
      package: '@example/asset-tools'
      registry: https://npm.pkg.github.com/
      version: 1.2.3
      integrity: sha512-<base64 digest of the published archive>
  use:
    - plugin: assets
      from: asset-tools
```

The checksum above is a placeholder, not a valid example for execution. The
agent obtains the real value through the proposed read-only broker command:

```text
shipit plugin package resolve --registry https://npm.pkg.github.com/ --package @example/asset-tools --version 1.2.3 --json
```

The command reads authenticated registry metadata for the exact version and
returns normalized registry, package name, version, and SHA-512 integrity. It
does not install, execute, publish, or edit files. Missing strong integrity is
an explicit unsupported-metadata error in the first version. The agent writes
the declaration as an ordinary reviewable project change. Trust starts with
the authorized registry and package; a checksum does not certify the author.

`plugins.repos` stays accepted with its current syntax. Both lists normalize
to one internal `DeclaredPluginSource[]`, and share the same name reservation
and `plugins.use.from` namespace. A duplicate name across lists is an error,
not precedence. One package may export several plugins through the existing
`exports.plugins` block. The selector logic and per-export overrides stay shared.

Validate exact SemVer including explicit prereleases; reject ranges, tags,
Git/file/URL dependency specs, missing fields, and malformed SRI. Registry URLs
are canonical HTTPS bases, including a path for registries mounted below `/`.
Reject userinfo, query, fragment, and encoded path tricks; retain path identity.
No implicit fallback to public npm or an ambient `.npmrc` is permitted.

## Package authoring and release

The npm archive must contain `package.json` and root `shipit.yaml` with
`exports.plugins`. Manifest paths resolve from the extracted package root.
ShipIt reads only the export block from this file: a packaged `agent.install`,
`plugins`, or `release` block does not configure the consuming workspace.

An author can use a release staging directory with this package file:

```json
{
  "name": "@example/asset-tools",
  "version": "1.2.3",
  "files": ["dist/", "skills/", "compose.yaml", "shipit.yaml"],
  "publishConfig": {"registry": "https://npm.pkg.github.com/"}
}
```

This is a file allowlist; npm also includes some standard metadata files.
`private: true` must not be used to mean restricted registry access: it prevents
publication. Package visibility and permissions are set in the registry.
See the [npm package format](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).

The author's release workflow builds, packs, inspects the archive's path list
and size, tests the extracted archive with the examples absent, and publishes
that same tested archive. Any LFS file needed at runtime must be materialized
before packing; a pointer is not usable runtime content. Omitted LFS files need
not be downloaded in the release build if the build does not use them.

npm packaging does not make a program self-contained. Prefer bundled runtime
code/dependencies, including private dependencies, or a declared service image.
Native binaries must match the plugin runtime; packaging does not change
ShipIt's existing image/runtime selection. A plugin can retain its explicit
`exports.plugins.<name>.install` for public dependencies and build steps under
existing egress and container rules. Its lockfile must actually be in the
archive (`npm-shrinkwrap.json` is publishable; `package-lock.json` is normally
omitted by npm). No implicit `npm install` occurs when ShipIt downloads a package.

The first version does not broker private transitive dependency installation.
Such dependencies must be bundled or included in the runtime image. The
registry fetch token is never a workaround for this boundary. Root npm
`preinstall`, `install`, `postinstall`, and `prepare` scripts are not run by
the acquisition step. An explicit export install still runs only in the
existing isolated install container, after archive verification.

The publisher's existing CI owns `npm publish` and write credentials. ShipIt's
current release mechanism can trigger that repo-owned workflow; this feature
does not add package publishing to `shipit release` or claim a GitHub Release
proves that npm publication succeeded. The consuming agent resolves the version
only after it exists in the registry. GitHub Packages is one supported target,
not a hard-coded transport: its documented external-client authentication uses
a classic PAT with package read permission, while appropriately authorized CI
can use `GITHUB_TOKEN`. A GitHub App repository token is not assumed to work.
See [GitHub's npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

Development keeps `repo: self`, the normal workspace setup, and normal LFS
materialization. Published manifest paths may point at built output; authors
must build that output during development or generate the release manifest in
the staging directory. Git branch consumers remain useful for testing a change
before release. Changing the same import name between Git and package sources
is an explicit project edit, with the existing source-retirement behavior.

## Registry settings and credentials

Add a Package registries section to existing Settings integrations. Each entry
holds canonical registry base URL, label, allowed package scopes/exact names,
and a masked bearer token or explicit anonymous mode. The user enters the token
through the existing secure settings input pattern, not chat. Store tokens in
the orchestrator's `CredentialStore` with its existing encryption behavior;
never put them in project `SecretStore`, exported environment, agent-visible
settings snapshots, or a plugin `.npmrc`. Only configured presence is readable.

Settings authorize the destination and package namespace. A project declaration
selects within that grant; it cannot create a new registry credential binding.
An npm unscoped package needs an exact-name grant. No global token or GitHub
token fallback. Rotate/remove credentials in the same inline settings surface.
All projects authorized for a configured scope can reuse that entry, matching
ShipIt's existing instance-level credential model. This does not introduce a
multi-tenant authorization system.

Use an orchestrator HTTP client with explicit request options. Send bearer auth
only within the configured registry base path. Cross-origin tarball locations
or redirects require operator-configured download origins; they receive no
registry Authorization header. Same-origin redirects outside the authorized
base path also receive no token and need an explicit download-path grant.
Signed download URLs remain transient and are redacted from logs. Reject
non-HTTPS redirects, userinfo, unapproved destinations, and redirect loops.
Apply destination checks on every hop; self-hosted private network endpoints
must be explicitly configured by the operator, not admitted by package metadata.
The grant must cover the resolved address policy as well as hostname so DNS
changes cannot turn a public download into access to internal services.

Package download authority is separate from plugin runtime egress. Fetching an
archive must not add registry hosts to the session's network permissions.
Check the registry grant before each new activation. No private archive cache
is shared in the first version.

## Acquisition and activation

1. Parse the consumer declaration and resolve its configured registry grant.
2. If the exact revision is already active and its install covers the selected
   exports, retain it through the existing unchanged shortcut. Otherwise read
   metadata, check exact name/version/integrity, and stream the archive into
   attempt-local temporary storage. Compare SHA-512 with the declaration.
3. Extract into a new session-owned staging directory. Require the npm
   `package/` root and strip only that prefix. Reject absolute/traversal paths,
   symlinks, hardlinks, devices, duplicate paths, and ShipIt-owned record names.
   Normalize permissions (regular files/directories, executable bit where
   needed; no archive uid/gid or setuid bits). Enforce limits on compressed
   bytes, expanded bytes, file count, response size, and time. Initial defaults:
   512 MiB compressed, 2 GiB expanded, 100,000 entries, 8 MiB metadata, five
   redirects, and five minutes total per acquisition; operator-adjustable.
   Archives requiring links are unsupported in this first version.
4. Check extracted `package.json` name/version, root manifest, selected exports,
   and manifest path containment. Missing referenced files fail before publish.
   Do not read package scripts during extraction. No Git or LFS call is made.
5. Run selected export installs in the existing install container with the
   staged files and writable generation layer. Registry auth is absent.
6. Validate and publish through the existing generation flow, then reconcile
   CLI/skills/services through their existing integration. Retain existing
   serialization, source checks, cancellation, and generation leases.

Reuse the staged activation structure; do not create a parallel package service
manager. A POSIX symlink swap only makes the published file pointer atomic.
It does not atomically restart Docker services: reconciliation must retain the
existing coherence gate, expose progress/failure, and avoid marking the new
version ready while a service still runs the old generation. This is an
integration test obligation, not an assumed consequence of the symlink.

## Identity, persistence, and caches

Separate three facts that are currently often called `commit`:

| Fact | Git | npm package |
|---|---|---|
| Source | Existing canonical repository identity | Canonical registry base + package name |
| Content revision | Exact Git SHA | Exact version + SHA-512 archive integrity |
| Installed generation | Existing SHA plus optional rebuild suffix | `pkg-` plus hash of the full tuple, plus optional rebuild suffix |

Use a discriminated `PluginRevision` union, not a fabricated Git SHA. Preserve
existing Git source keys and generation directory names. Add package keys with
an unambiguous namespaced serialization; path names are hashes, never raw URLs
or scoped package names. Cache and dependency keys include source kind and
canonical registry identity, not only version, package name, or display alias.

Generation records gain a schema version and revision union. New readers accept
legacy Git records using their existing source/commit/id. Package records do
not set `commit`. Before producing any package directory, change debris cleanup to positively
recognize only ShipIt's `.staging-<uuid>` and `.replaced-<uuid>` names. An unknown
name must be retained/reported, never treated as disposable. Known generations
still require their deletion lease. `dropGenerations` currently deletes every
nonmatching generation name outside that lease; new `pkg-` names are therefore
unsafe under an old orchestrator.

Ship this cleanup compatibility change first. Package support can be enabled
only once the deployment's supported rollback target includes it; mixed
orchestrator writers that predate it are unsupported. Do not roll back below
that target while package generations exist. To do so, first disable package
sources and remove their containers/generations through the new leased cleanup
path. Changing the forward parser alone does not make rollback safe. Container record guards, overlays, leases, install records, status,
feedback context, and snapshot types must use the same revision/generation.
Unsupported old workers must fail package preparation visibly; require the new
worker capability before activation, while keeping old Git sessions usable.
Use an additive optional `pluginPackageSources: true` capability in the existing
worker status response. Absence means unsupported. Check it before publishing
or starting package services, and show that the session worker needs an update;
do not stop running work to rotate it. Keep Git wire fields compatible and send
new package fields only to workers that advertise support. This needs no general
worker-version subsystem: `shared/types/worker-wire-contract.test.ts` verifies
an additive contract today and explicitly says there is no version handshake.

Expose `SHIPIT_PLUGIN_REVISION` as an opaque stable content identity for
external sources on all runtime surfaces. Keep `SHIPIT_PLUGIN_COMMIT` unchanged
for Git and absent for packages. Self-development has neither immutable
identity. A rebuild changes generation identity, not content identity. Reserve
the new name so author credentials/settings cannot override it. Do not also add
`SHIPIT_PLUGIN_VERSION`: package code can read its own `package.json` for that.
The revision includes source and integrity: a bare version such as `1.2.3` is
not sufficient for a project cache that survives a source/registry change.

Do not add a persistent archive cache in v1. Each cold activation or forced
rebuild downloads the selected release again; temporary archives are deleted
on success, error, and cancellation, with boot cleanup for crash leftovers.
Active generations remain under session state and are reused. Workspace
reclamation that leaves the generation intact needs no download; missing
generations are restored from the registry. Cold offline activation is not
supported. This trades repeated downloads of the small release for much less
cache/authorization/eviction machinery. A future archive cache can be added
without changing declarations if measured package sizes justify it.

The declaration's checksum is the portable lock across installs, forks, and
checkout reclamation. No separate package lock database is needed. A registry
that removes the release produces a visible unavailable error, never a Git
clone fallback. Removing a local registry grant blocks new activation; it does
not erase code already loaded by a running plugin. Upstream revocation is
observed on network access, not used to promise revocation of downloaded code.

Retain existing dependency download caches, per-generation writable layers, and
eligible shared dependency bases. Source keys include the registry and package.
Verified at `plugin-dep-store.ts:pluginDepScope, adoptPluginDepBases,
promotePluginDepDirs` and `overlay-base.ts:publishBase`: the plugin branch uses
content-addressed scopes and `isAncestor: async () => false`; its candidate
`commit` is compared as a string, never passed to Git. Pass the opaque content
revision through this narrow adapter and document the legacy field name.
Do not expose it as a Git commit in records or user-facing output. Tests must
prove a second session adopts the same eligible dependency base without
reinstalling, and no package revision reaches a real Git ancestry callback.
Existing eligibility checks still refuse unsafe input hashes or prebundled
dependency directories; package support does not weaken them.

## Updates, failures, and inline behavior

Add package rows to the existing Plugins tab. Show package name, registry label,
declared version, actual active version, checksum detail, install state, and a
clear error when these differ. Keep needs, preview, commands, and settings on
the existing surfaces. Rename user-facing groups from repositories to sources
where both kinds appear; do not change working Git declarations.

Package declarations are pinned. Refresh retries/revalidates the same content;
`--force` rebuilds it beside the live generation. Upgrading or rolling back is
an agent edit of version AND integrity in `shipit.yaml`, resolved through the
broker. No background update polling or automatic mutation of project files.
If the registry returns different bytes for the same pin, refuse them. The
agent must not silently replace integrity to clear that error.

Within one source, a failed candidate keeps the old complete generation marked
stale with its actual version. A source change first retires the old exposure;
failure of the new source means unavailable. Preserve per-import runtime state
and project data through either change. Downgrading code does not roll back a
plugin's data migrations; plugin compatibility remains the author's concern.

Errors distinguish registry not configured, missing/expired token, access
denied or private-package-not-found, missing version, checksum mismatch,
unsupported metadata/archive, invalid exports, install failure, and service
reconciliation failure. The session opens even if the package is unavailable.
Settings and plugin status stay inside ShipIt, in line with product principles
1–5. No link-out is the main recovery path and no shell-command button is added.

Package metadata (`repository`/`bugs`) must not silently authorize feedback
posts. For v1, package rows report that direct package feedback is unavailable;
an agent may use an explicitly declared issue tracker under its normal grant.
Existing Git feedback continues. The runtime context includes actual package
version/integrity rather than pretending it is a repository commit.

No new transcript card is needed. Any added result that is rendered in chat
must use the existing persisted card/message path and owning session ID; a
status GET remains read-only and does not trigger activation.

## Source checks and implementation map

These dependencies were checked in code while writing the proposal. They are
not claims that package support already exists.

| Area | Verified current code and proposed change |
|---|---|
| Parse/types | `shared/plugin-repos.ts:PluginRepoSource, parseRepoEntry` accepts GitHub/self only. Add package declarations and normalized source union; update `shipit-config.ts` and shared snapshot types. |
| Acquire | `plugin-generations.ts:checkoutCommit` clones from a bare Git cache. Isolate Git resolution/materialization; add `plugin-package-fetch.ts` and guarded archive extraction. |
| Credentials | `plugin-fetch.ts:resolvePluginFetchCredential` resolves repository-specific Git auth. Add a separate registry resolver and explicit request client; extend `credential-store.ts` without exporting its secrets. |
| Activation | `plugin-generations.ts:activateOnce` calls `runInstall`, then `validateStaged` in a serialized publish window. Inject resolved revision/staging while retaining that ordering. |
| Ownership | `plugin-generations.ts:checkoutCommit` uses the object-aware Git handback. Packages have no Git hardlinks; give new staging content to the session identity without chowning shared cache content. |
| Rebuild/prune | `plugin-generations.ts:GENERATION_ID_RE, generationIdFor, pruneOldGenerations` assumes SHA-shaped names. First positively recognize temporary debris; accept typed package IDs and retain leases; see the [generation rebuild design](../273-plugin-generation-rebuild/plan.md). |
| Guards | `shared/plugin-generation-record.ts:readPluginGenerationSource` gates source identity. Update it and `session/plugin-runtime.ts` to reject foreign package generations. |
| Worker wire | `shared/types/agent-types.ts`, `worker-wire-contract.test.ts`, `session/session-worker.ts`, and `container-session-runner.ts` add/check the optional package capability before activation. |
| Install/cache | `plugin-install.ts`, `plugin-install-record.ts`, `plugin-dep-store.ts:planPluginDepStore, promotePluginDepDirs` carry commits. Use revision in install stamps/diagnostics; retain eligible content-addressed dependency bases through the opaque revision adapter. |
| Mount/runtime | `plugin-overlay.ts`, `plugin-leases.ts`, `plugin-compose.ts`, `plugin-cli-run.ts`, `services/plugin-services.ts`, `shared/plugin-contract.ts` must agree on generation and content identities. |
| Status/update | `services/plugin-activation.ts`, `plugin-status.ts`, `plugin-refresh.ts`, `shared/plugin-feedback.ts`, `client/components/PluginReposPanel.tsx` project typed revisions and package-specific actions. |
| Transport/settings | New `services/package-registries.ts`, thin settings routes, and a session-scoped read-only package-resolution route; wire through `app-di.ts`, `api-routes.ts`, shared types, the existing settings client pattern, and `session/agent-shim/shipit-plugin.ts`. |
| Reclamation | `startup-janitor.ts` cleans abandoned acquisition scratch; `plugin-dep-store.ts:livePluginStoreArtifacts` protects package dependency caches/bases without calling `pluginCloneUrl`. No new steady-state archive cache tier. |
| Agent docs | At implementation, update `src/server/shipit-docs/plugins.md`, `plugin-authoring.md`, `shipit-yaml.md`, and registry setup reference. Keep proposed syntax out of current runtime instructions until it works. |

Proposed HTTP surface: `GET /api/settings/package-registries` returns redacted
entries; `PUT /api/settings/package-registries/:id` creates/updates settings;
`DELETE` removes one. The resolve route is
`POST /api/sessions/:id/plugin/package/resolve`, with validated registry,
package, and version arguments. The agent shim calls its worker at
`POST /agent-ops/plugin/package/resolve`; `session/agent-ops-routes.ts` relays
through the existing worker-to-orchestrator session client. Add the exact suffix
to the container-accessible own-session route allowlist in `api-container-guard.ts`.
Never grant a broad `/api/plugins/*` exception. Browser callers use the same
session route and service. Reuse existing
authenticated settings authorization. Registry settings routes are NOT
container-accessible. The agent worker gets only the own-session resolve
operation; plugin execution containers get neither settings nor resolve routes. Use explicit token replace/remove operations, with no
returned secret and no token value in validation errors. The resolve endpoint
is POST for a bounded broker request, but does not mutate the project or activate
anything. Client and agent shim share the service implementation.

## Delivery and validation

Implement in small slices, with package syntax inactive until the complete
acquisition-to-runtime path exists. First add typed identity and backwards
compatibility tests after the cleanup prerequisite; then registry settings/acquisition; then wire activation,
temporary cleanup, runtime contract, and UI. Finish with author documentation and
a private-package acceptance run. Do not enable partial support that reads the
manifest but cannot execute the package coherently.

Tests must prove:

- Parser compatibility, exact versions/checksums, cross-list collisions,
  scoped names, registry path identity, and refusal of alternative package specs.
- HTTP/CLI auth, masked responses, token rotation/removal, no credential fallback,
  redirect/path/DNS boundaries, and timeout/size limits.
- Archive traversal/link/device/duplicate/record-name rejection, incorrect
  checksum, interrupted downloads, missing manifest, and package identity mismatch.
- npm lifecycle scripts do not run during acquisition; an explicit export
  install runs in its container without the registry token.
- Two sessions have independent package files/layers and reuse eligible shared
  dependency bases. Concurrent resolve/cancel/reclaim leaves no half-published
  generation or leaked acquisition scratch.
- Upgrade, rollback, forced same-version rebuild, source change, failure before
  publish, service failure after publish, foreign-record rejection, and restart
  restore show the actual revision consistently across UI, CLI, and service.
- Legacy Git records and old workers behave as documented. No old-generation
  prune can remove a mounted package generation, including the supported rollback
  release. No package revision reaches Git ancestry code.
- The private acceptance fixture has omitted large LFS and ordinary debug
  files. Network spies prove package activation makes no Git/LFS requests and
  needs no source-repo permission. Zero LFS requests is a regression guard, not
  a claimed change from current Git plugin acquisition. The development fixture
  retains its files.
- Browser verification covers package success, missing auth, stale update,
  settings token masking, and mixed Git/package rows. HTTP route tests cover
  happy/error paths; any transcript result survives reload/session switching.

Run affected tests, `npm run lint:dev`, and `npm run typecheck` after code
implementation. This design-only change needs link/config-example review and
an independent design review, not a full runtime test run.

## Alternatives and limits

- LFS exclusion: already the default in orchestrator Git plugin acquisition.
  It does not exclude non-LFS development files or remove source-repo access.
  A repository-wide exclusion would additionally affect developer defaults.
- A separate private distribution Git repository: can work with today's Git
  sources and a CI-built tree. It avoids registry support but adds a second
  repository and synchronization process; keep it as a fallback, not required.
- A private release archive transport: also valid, but does not provide the
  npm-compatible distribution path requested here. Do not implement both now.
- A universal plugin package manager, transitive private dependency proxy,
  mutable version ranges, automatic upgrades, archive cache, publication UI, or a new lockfile:
  remove from v1. None is needed to install an explicitly selected private release.

Open for later user direction: which registry to deploy first, and whether
private install-time dependencies are needed beyond bundled release contents.
Neither blocks this design. The proposal supports the bearer-token subset
above; it does not claim all npm-compatible authentication schemes work.

## Design review disposition

An independent ShipIt-selected reviewer checked this proposal against the source
and reviewed it for simplification. The resulting changes are part of the design:

- Correct the LFS premise using the orchestrator Dockerfiles. The reported
  downloads still need a separate diagnosis if that is wanted.
- Require positive temporary-debris matching in a prerequisite release and
  document the rollback floor. Forward generation parsing alone was not enough.
- Retain the existing dependency base path after verifying that its plugin
  adapter compares revision strings without Git ancestry operations.
- Remove the proposed persistent archive cache from v1 and state the cold
  download/offline tradeoff.
- Specify the worker agent-ops relay and own-session resolve route explicitly.
- Remove the separate runtime version variable. Keep one source-aware content
  revision variable because a version alone is not an identity across sources.

The review suggested that unknown-source diagnostics could replace the worker
capability check. Keep the additive capability check instead: an already-running
old worker has neither the new parser nor those diagnostics, and can silently
drop package declarations. New diagnostics alone cannot fix that old process.
The plan now states the new optional status field and the gate before activation;
it does not assume an existing capability subsystem. Future parsers should also
report unsupported source kinds through the existing preparation issues channel.
