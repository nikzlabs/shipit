---
issue: planning#627
title: Credential for a declared Git LFS host — plan
description: One resolver registered at boot attaches a ShipIt-held LFS host credential to ShipIt's own Git LFS transfers, and the session's credential broker answers for that host.
---

# 320 — Plan

Implements [requirements.md](requirements.md).

## Declaration (reqs 1, 2, 11)

```yaml
lfs:
  host: lfs.example.com          # exact host, optional :port
  credential: LFS_CREDENTIAL     # name of a secret in Project Settings → Secrets
```

`parseLfsHostConfig` (`shared/shipit-config.ts`) warns and ignores the whole
section on: a `host` that is not dot-separated labels with an optional port (a
wildcard, a scheme, a path, or a trailing dot, which would make `github.com.` a
second spelling of GitHub: req 11), `github.com` (req 1), or a `credential`
outside `^[A-Za-z_][A-Za-z0-9_]*$`. A `:443` is dropped, because that is how the
secret's URL reads back.

The name rule is the one compose `x-shipit-secrets` and plugin credentials
already enforce, and it is what keeps the feature from widening what the agent
can read. `shipit.yaml` is agent-writable, and the session's credential helper
hands the secret to the agent (req 10). Any secret with an identifier name is
already agent-readable: a compose entry with `agent: true`, or code the agent
wrote running in a service, reads it (`shipit-docs/secrets.md`). A stored secret
with any other name is reachable by neither, so `lfs.credential` must not reach
it either.

## The secret (reqs 3, 4, 6)

`parseLfsHostSecret` (`orchestrator/lfs-host-credential.ts`) refuses a control
character in the raw value (`URL` would silently drop a line break) and again in
the decoded username and password (a line break there would add lines to the
credential helper's answer). It reads the value with `URL`. It requires the `https:` scheme, a non-empty username and password
(both percent-decoded, as git's credential-store does), and no path. `URL.host`
must equal the declared host. Anything else is a **refusal**: a ShipIt-authored
reason plus the declared host it is about, never the secret's value.

The host inside the secret is the binding (req 4). Editing `shipit.yaml` can
point the declaration anywhere, but a secret is presented only to the host
written inside it. So redirecting a secret takes editing the secret.

## The four LFS transfers ask for it (reqs 7, 8, 9, 12)

Every ShipIt-side git credential already comes from `resolveTreeRemoteCredential`
(`shared/git-remote-credential.ts`). The LFS host credential is attached there,
but only when the caller passes `{ lfsHost: true }`: the pre-push upload
(`GitManager`), the provisioning and restore pull (`materializeLfsContent`), the
shared store's fill (`fetchLfsIntoCache`) and the diff viewer
(`createLfsBlobResolver`). A fetch, a ref push or an `ls-remote` never talks to
the LFS host, so it never carries its secret. `GitManager` resolves once per
push and hands the ref push `withoutLfsHost(credential)`.

- `configureLfsHostCredentialResolver` registers one `(dir)` resolver at boot
  (`app-di.ts`, beside the `SecretStore` it reads), so none of the dozen pull
  call sites has to thread it through (docs/231-git-lfs-support §7).
- **The repository is ShipIt's record, never the tree's `origin`.** The agent can
  edit `.git/config`. Keyed by `origin`, it could point a workspace at another
  repository and have ShipIt present that repository's secret. `repoUrlForDir`
  answers from the session row whose `workspace_dir` is the tree
  (`SessionManager.remoteUrlForWorkspaceDir`), or from the repo store for a bare
  cache. No record means no lookup, and a refusal saying so. Provisioning needs
  the repository before its pull: warm sessions record `remoteUrl` first, the
  claim slow path now does too, and `forkSession` passes `{ repoUrl }` to its pull
  instead. Creating the fork's row early would list a half-provisioned fork in
  the sidebar.
- The declaration comes from `<dir>/shipit.yaml`, or in a bare cache from the ref
  its LFS fetch uses (`resolveCacheFetchRef`, which survives a renamed default
  branch leaving `HEAD` dangling). A repository with no `lfs:` section costs one
  config read, and only on an LFS transfer.
- `GitRemoteCredential` gains `lfsHost` and `lfsHostRefusal`. With a declaration
  it is returned even when the remote has no token. The config then still opens
  with the `credential.helper=` reset, so a helper written into the workspace's
  `.git/config` cannot answer for the declared host, whether it is presented or
  refused (req 8).
- `withPreemptiveAuthFallback`'s anonymous retry after the remote refuses its
  token drops that token and keeps the LFS host's credential.
- `gitCredentialConfig` adds `credential.<lfsOrigin>.helper`, which echoes
  `$SHIPIT_LFS_CRED_USERNAME` / `$SHIPIT_LFS_CRED_PASSWORD`. `gitCredentialEnv`
  supplies them. Only variable names enter argv (req 7), and `assertSafeOrigin`
  checks the LFS origin as it does the remote's (req 12). No preemptive header:
  git-lfs asks the helper after its first 401.

**What the environment exposes, and why that widens nothing.** The secret sits in
the environment of the `git lfs` it authenticates. A workspace's `.git/config`
can name programs git-lfs runs (`lfs.customtransfer.<name>.path`,
`lfs.standalonetransferagent`), and those inherit that environment. This is the
exposure the GitHub token already has on the same commands. Orchestrator git on a
workspace runs as the workspace's uid (docs/266-orchestrator-git-trust-boundary),
so such a program runs as the agent, and it can read only what the agent can
already read through the broker (req 10). Keying on ShipIt's record is what keeps
another repository's secret out of that environment.

## The session's credential broker (req 10)

`POST /api/sessions/:id/git/credential` (`api-routes-github.ts`) runs the same
resolver on the session's workspace and `remoteUrl` for any host other than
github.com. It answers `{ username, password }` only for `protocol=https` and
the credential's exact host. For a refusal about the requested host, it answers
404 with `{ warning }`, which `shipit-git-credential` prints on stderr. Any other
host gets the 404 it always got.

## Reporting a refusal (req 5)

- **Push:** `uploadLfsObjects` puts the refusal in front of git-lfs's output in
  the `LfsUploadError`, so docs/231-git-lfs-support §8's chat notice says why.
- **Pulls:** `materializeLfsContent` adds it to its warning, even after a
  successful pull (the server may allow anonymous reads and not uploads). That
  warning already reaches a toast or the agent notice.
- **The agent's own git:** the credential helper's stderr, whenever its `git lfs`
  asks for that host.
- **The shared store's fill and the diff viewer:** their failure logs.

So the user always sees a refusal, as a toast after each provisioning pull and in
the push notice. The agent sees it when its own git needs that host. A server
that allows anonymous reads, on a branch that uploads nothing, is the one case
where the agent is not told: then nothing it does needs the credential.

## Egress (req 13)

`shipit.yaml` gains no path to the egress allowlist. The agent-facing docs tell
the user to allow the LFS host, and the storage host its server redirects to, in
the existing egress settings.

## Docs (req 14)

`shipit-docs/shipit-yaml.md` § `lfs`; `shipit-docs/environment.md` § Git LFS;
`shipit-docs/secrets.md` (custom secrets); wiki `repos-and-sandboxes.md`
("Secrets for a project").

## Key files

- `src/server/shared/shipit-config.ts` — `lfs` section, `parseShipitConfigText`
- `src/server/shared/git-remote-credential.ts` — registration, the attach in
  `resolveTreeRemoteCredential`, the second scoped helper
- `src/server/orchestrator/lfs-host-credential.ts` — declaration read, secret
  parse, the resolver
- `src/server/orchestrator/app-di.ts` — registration at boot, and `repoUrlForDir`
- `src/server/orchestrator/sessions.ts` — `remoteUrlForWorkspaceDir`
- `src/server/orchestrator/services/claim-session.ts`,
  `services/session-fork-merge.ts` — record `remoteUrl` before the pull
- `src/server/orchestrator/api-routes-github.ts` — the broker's answer
- `src/server/session/agent-shim/git-credential.ts` — prints a refusal
- `src/server/shared/git.ts`, `src/server/orchestrator/git-lfs.ts`,
  `src/server/orchestrator/git-lfs-store.ts`, `git-lfs-blob.ts` — ask for the
  LFS host, and report a refusal
- `src/server/orchestrator/lfs-host-credential.test.ts` — secret parsing, the
  resolver on a checkout and a bare cache, and the end-to-end push against a real
  HTTPS LFS server that requires Basic auth
