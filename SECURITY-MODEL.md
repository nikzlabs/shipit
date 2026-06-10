# ShipIt Security Model

This document describes **how ShipIt protects you** — the trust boundaries it draws,
the defenses behind each one, and the risks it has consciously accepted (and plans to
close). It is the companion to [SECURITY.md](SECURITY.md), which covers a different
question: how to *report* a vulnerability. If you've found a flaw, start there.

ShipIt's entire job is to let an AI agent write and run code on your behalf. That makes
the agent a powerful but only **semi-trusted** actor, and it makes everything around the
agent — credentials, the host, other sessions — a boundary worth defending. The sections
below walk those boundaries from the outside in.

## Threat model

ShipIt is designed as a **self-hosted, single-tenant** tool: one person, or a small
trusted team, running their own instance against their own repositories and
infrastructure. The security model is built around that assumption. The actors are:

- **You (and your team)** — fully trusted. You decide what to build and grant ShipIt
  access to your repos and credentials.
- **The agent (Claude Code / Codex)** — semi-trusted. You *want* it to write and execute
  code inside its session, so "the agent ran code" is by design, not a breach. But the
  agent acts on instructions that can be influenced by untrusted input — a malicious
  README in a cloned repo, a poisoned dependency, a crafted issue body — so ShipIt treats
  a **prompt-injected agent** as a realistic adversary and works to limit what one can
  reach.
- **Repository and web content** — untrusted. Anything the agent reads (repo files, fetched
  pages, MCP responses) may try to steer it.

The boundaries ShipIt defends, in priority order:

1. **Container → host / orchestrator.** Agent-controlled code must not escape its session
   container.
2. **Session → session.** One session must not read another's files, credentials, or history.
3. **Container → high-value credentials.** A compromised session should reach as few
   credentials as possible — and never the ones that would let an attacker impersonate you
   broadly (your GitHub PAT, your tracker tokens).
4. **Instance → internet.** A self-hosted instance exposed to the network must sit behind
   an access layer you control.

## Supply-chain defenses

The code that runs your agent is only as trustworthy as the packages it's built from, so
ShipIt locks its dependency graph down hard.

- **Exact version pinning, enforced.** Every entry in `package.json` must be an exact
  semver — no `^`, `~`, ranges, tags, or git/tarball URLs. A floating range turns
  `npm install` into a moving target and lets a fresh checkout silently pull a version
  nobody reviewed. This is enforced by `scripts/check-dependency-age.ts`
  (`npm run check-deps`), which is wired into CI and fails the build on any violation.
- **Minimum release age.** Dependencies must have been published for a cooldown window
  before they can be added, giving the community, scanners, and npm's own abuse pipeline
  time to catch a compromised release before it reaches the build.
- **Agent CLIs are lockfile-pinned and installed with `npm ci`.** The Claude Code, Codex,
  and Playwright-MCP CLIs live in a separate `docker/agent-cli/` manifest with a committed
  lockfile. The session-worker image installs them via `npm ci --ignore-scripts`, so
  versions are deterministic and **lifecycle/postinstall scripts don't run** across the
  tree. Bumps are gated: Renovate proposes them with a multi-day cooldown and **no
  auto-merge**, so a human reviews every agent-CLI change.
- **No silent drift.** Because everything is pinned and lockfile-installed, what you build
  and run is exactly what was reviewed — a dependency bump is always a deliberate,
  reviewable edit, never a side effect of re-running install.

## Credential and secret isolation

The single most important principle: **high-value credentials stay in the orchestrator and
are brokered to the container on demand — they are not handed to the agent's sandbox.**

- **Server-side credential store.** GitHub tokens, agent OAuth/subscription auth, MCP
  secrets, tracker tokens, and voice-provider keys are stored server-side
  (`credential-store.ts`, mode `0600`; per-repo secrets in `secret-store.ts`). They are
  **never echoed back to the browser** — settings endpoints report "configured / not
  configured," never the value.
- **GitHub token brokering — the PAT never enters the container.** Git operations inside a
  session (`push`, `pull`, `fetch`) work via a brokering credential helper
  (`shipit-git-credential`): on a credential request, it asks the orchestrator over the
  worker HTTP channel, which returns a token **only for `github.com`** and only in transit.
  The container's generated `.gitconfig` is **token-free**, and `store`/`erase` are no-ops.
  A prompt-injected agent can't `cat` your PAT out of a config file, because it isn't there.
- **Per-session, per-agent credential subtrees.** Each session mounts its own
  `/credentials` subpath, and only the *pinned* agent's files are copied in — a Claude
  session never sees `.codex`, and vice versa.
- **Tracker tokens stay orchestrator-side.** The agent reads and updates Linear / GitHub
  issues through a tracker-neutral, ShipIt-brokered interface (the `shipit issue` command).
  The actual GraphQL/REST calls happen in the orchestrator with the token in the
  Authorization header — **tracker tokens never enter the session container.**
- **Compose secrets are scoped.** Secrets declared for your Compose services are resolved
  from the per-repo secret store and delivered to the service that needs them. A
  repo-controlled `docker-compose.yml` can **no longer** ask ShipIt to forward your global
  platform credentials (Claude/GitHub/MCP) into a service — that forwarding was removed.
  Secrets explicitly marked for the agent are documented as reachable by the agent (see
  Known limitations).
- **Redaction before anything leaves the box.** Bug reports filed from inside ShipIt run
  through a two-stage redactor (`services/redaction.ts`): a deterministic regex floor that
  scrubs known key shapes (Anthropic `sk-ant-*`, OpenAI `sk-*`, GitHub `ghp_*` /
  `github_pat_*`, AWS/Google/Slack tokens, JWTs, bearer tokens, emails, SSH remotes,
  credential-bearing URLs, workspace paths), plus an optional LLM semantic pass that
  returns *spans to redact* (never rewritten text, so it can't be used to inject content).
  You see and can edit the final, redacted body before it is submitted.

## Agent and container containment

Each session runs in its own Docker container, and ShipIt assumes the code inside it may
be hostile.

- **One container per session, on an isolated network.** Every session gets a dedicated
  container on its own session bridge network. Sessions **cannot reach each other's
  containers**; only the orchestrator is reachable from inside.
- **No Docker socket in the container.** Containers never get the host Docker socket.
  Instead, `DOCKER_HOST` points at a **Docker API proxy** (`docker-proxy.ts`) that enforces
  an explicit allow-list. The proxy identifies the calling session by its unique bridge IP
  (and `NET_RAW` is dropped in every container to prevent IP spoofing), then checks that
  every container/network/volume operation targets resources **owned by that session**
  (verified via a `shipit-parent-session` label).
- **Dangerous container options are rejected, not just discouraged.** The proxy's
  sanitizer (`docker-proxy-sanitize.ts`) rejects `Privileged: true`, any `CapAdd`,
  host or `container:*` network/PID/IPC namespace sharing (and host UTS sharing),
  `VolumesFrom`, and strips
  `SecurityOpt`, `Sysctls`, `UsernsMode`, `CgroupParent`, `Runtime`, and similar escape
  hatches. Bind mounts must resolve under the session's own workspace dir; named volumes
  must belong to the session. Resource limits (memory, CPU, PID) are enforced.
- **Orchestrator ↔ container is HTTP-only.** The orchestrator never uses `docker exec`. It
  talks to a Fastify worker inside each container over HTTP, and events stream back over
  SSE. The control channel is a well-defined API surface, not arbitrary command execution.
- **Preview proxy guards routing.** Browser previews reach containers through a reverse
  proxy (`preview-proxy.ts`) that validates the session-ID/port from the request, resolves
  the target container IP from **server-side session state** (not user input), and rewrites
  the `Host` header to the container's local dev server — closing off DNS-rebinding and
  SSRF-to-arbitrary-host vectors.

## Cross-session isolation

Sessions are independent all the way down:

- **Separate workspaces and clones.** Each session gets its own workspace subtree and its
  own full git clone (a fast, hardlinked local clone cut from a shared *read-only* bare
  cache — no shared worktree).
- **Separate credentials, history, and state.** Per-session credential subtree, per-session
  chat history, and per-session in-memory runner state (message queue, terminal buffer,
  event stream). There is no shared mutable session state that one session can use to
  observe another.

## Network exposure and access control

ShipIt has **no built-in user authentication** on the orchestrator — it relies on the
deployment putting an access layer in front. This is intentional for a single-tenant tool,
but it means **you must not expose a raw ShipIt instance to the public internet.**

- **Local install** binds to `localhost` only — nothing is exposed off the machine.
- **VPS install** offers, during setup, to put ShipIt behind **Cloudflare Zero Trust**
  (required SSO / email allow-list by default) and/or **Tailscale**, with **no open inbound
  ports** in either case. See [`deployment/README.md`](deployment/README.md) for the access
  policies.
- All session/preview/API routes validate the session ID against the session manager, but
  that is authorization *within* a trusted instance — it is not a substitute for the access
  layer above.

## Known limitations and accepted risks

Honesty is part of the security model. These are the gaps ShipIt is aware of, the reasoning
for accepting them today, and where they're headed.

- **Unrestricted agent network egress (the big one).** Agent containers have full outbound
  internet access. That means any credential that *does* live inside the container — the
  agent CLI's own OAuth/subscription token, MCP server tokens, and any secret you
  explicitly marked as reachable by the agent — can be **exfiltrated by a prompt-injected
  agent** (e.g. `curl`-ing it to an attacker). The most damaging target, your GitHub PAT,
  is *not* in the container (it's brokered), which is why brokering was prioritized. The
  planned mitigation is an **orchestrator-side forward proxy with a host allow-list**
  (GitHub, your configured Anthropic/MCP endpoints), so egress is restricted to the hosts
  the agent legitimately needs. Until then: treat anything you put inside the container as
  reachable by a compromised agent, and prefer the brokered paths.
- **Bind-mount validation has a TOCTOU window.** The Docker proxy validates that a
  child-container bind mount resolves under the session's workspace, but a time-of-check /
  time-of-use race exists in principle. Exploiting it requires an already-in-sandbox
  attacker, a pre-planted symlink, and precise timing; the workspace-path scoping and the
  dropped capabilities limit the blast radius. A `nosymfollow` / inode-based check is the
  intended hardening.
- **Session worker runs as root inside its container.** A non-root worker runtime is
  planned but deferred — it's a broad change and the container boundary (not in-container
  UID) is the primary control today.
- **Credential mounts are read-write.** Read-only credential mounts are a planned
  hardening, pending an isolated agent-resume path.
- **No orchestrator-level user auth.** As above, this is by design for single-tenant use
  and is covered by the deployment access layer — but it does mean an unprotected exposed
  instance is fully open. Don't run one.
- **Pathological-prompt denial of service** (an agent told to burn compute or disk) is a
  cost/usage concern, not a boundary breach, and is out of scope for the isolation model.

## Reporting a vulnerability

Found a way to cross one of these boundaries? Please report it privately — see
[SECURITY.md](SECURITY.md) for the process and scope. "The agent ran code I asked it to" is
working as designed; container escape, cross-session leakage, and credential exposure are
exactly what we want to hear about.
