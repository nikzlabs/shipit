---
issue: https://linear.app/shipit-ai/issue/SHI-215
title: Remote SSH from a session
description: Let a Sandbox session's agent run commands on a remote host over SSH via an opt-in `ssh` capability, using an SSH key from Secrets, with the egress allowlist gating which hosts are reachable.
---

# 228 — Remote SSH from a Session

## Overview

A session's agent should be able to run commands on a **remote host** over SSH —
`ssh deploy@prod.example.com 'cd /srv && ./deploy.sh'` — entirely from chat. The user
describes intent ("restart the service on prod"); the agent runs the `ssh` in its existing
Bash tool and the output renders inline. This is the in-ShipIt replacement for "open a
terminal, SSH to the box, run Claude there for setup/debugging" — including against the
ShipIt production machine itself.

This fits ShipIt's model without a new surface. Per product principle §5, **the agent is the
actor**: SSH-to-remote is not a shell-shaped button, it is the agent running a command on
the user's behalf, the same way it runs the tests or `git`. The agent already runs as a real
shell user (`shipit`, `HOME=/home/shipit`) with a Bash tool. SSH is just three things it is
missing — the **binary**, the **key**, and a **network path** — and each maps onto a
subsystem ShipIt already has. The bulk of this doc is therefore about wiring existing pieces
together and, far more importantly, about the **security boundary** (see below), because this
is the highest-value place in the product to hand a credential to a potentially
prompt-injected agent.

## Motivation

Today the only way to drive a remote host from a ShipIt session is to leave ShipIt — open a
local terminal, SSH out by hand. That violates §1 ("the user does not leave the surface").
The user explicitly wants to do remote setup/debugging, including on the ShipIt prod box,
from the web UI. The natural ShipIt shape is: store the SSH key once, name the reachable
host(s), and then just ask the agent in chat.

## Two shapes — and the one we're actually building

There are two distinct features hiding under "remote SSH," and they should not be conflated:

- **SSH *from* a session (the lighter one).** A Sandbox session with a local `/workspace` that
  can *also* `ssh host 'cmd'` for adjunct steps — deploy a build, run a remote test. The agent
  has a local filesystem and occasionally reaches out. This is what §0–§4 below describe, and
  it's cheap (binary + key + egress + the `ssh` capability).
- **A *Remote session* (the target).** The session's **execution environment *is* the remote
  host.** There is **no local filesystem**; the agent operates the box directly, the way you
  would after `ssh`-ing in and running an agent there — except the agent, the model, and its
  credentials **stay inside ShipIt's contained container** and only *commands* travel over SSH.
  This is "ssh to the box and run an agent on it" done right: nothing is installed on the box,
  no agent credentials are stored on it, and the work happens in ShipIt's chat surface instead
  of a local terminal. **This is the shape the user wants** (confirmed in design discussion).

The second is a new session **kind**, not just a capability toggle. Transparent remote execution
is the *whole-session contract* (the agent is told "your shell is host X" once at creation), not
a per-command decision — which is what keeps it coherent and avoids the local/remote split-brain
that a hybrid would create. The lighter SSH-from-a-session feature is a useful stepping stone /
lesser cousin; the mechanism sections (§1–§4) and the Security model apply to both.

### Where it sits relative to ShipIt's principles

A Remote session leans hard into being "the best remote-ops terminal" — it renders far less than
a normal repo session (no PR card, no diff, the file tree is remote-backed or thin). That is in
tension with §1–§4 ("ShipIt is the surface; render inline"), the same pill sandbox sessions
already swallowed as "a deliberate, scoped product degradation… closer to a terminal than a
project" (docs/211). It is nonetheless strongly aligned with **§1** (the user's own motivation is
"I do this over a local terminal and want to do it through ShipIt") and **§5** (the agent is the
actor operating the box). The conscious product call: *is ShipIt willing to be the best remote
chat-driven ops surface for this mode?* — answered yes, within the bounds below.

## Competitive landscape

Surveyed June 2026. The axis that matters is **where the agent (and its model credentials / LLM
egress) runs, and whether the remote box must host it.** Existing tools fall into four camps:

1. **Agent installed *on* the remote box** — you SSH in and run the agent there.
   [Warp](https://docs.warp.dev/agent-platform/cli-agents/claude-code) "Warpifies" an SSH
   session and runs Claude Code on the remote (file tree needs Warp's SSH extension);
   [Claude Code's Desktop app SSH hosts](https://code.claude.com/docs/en/desktop-quickstart)
   **auto-install Claude Code on the remote machine** on first connect; the hand-rolled
   `ssh box "claude -p …"` + `tmux` pattern is widely blogged. **Downside: the agent, its
   credentials, and its LLM egress all live on the box** — exactly what a Remote session avoids.
2. **Web/mobile UI that *remote-controls* a Claude session** — [Omnara](https://www.omnara.com/),
   [Happy](https://happy.engineering/),
   [CloudCLI / claude-code-ui](https://github.com/siteboon/claudecodeui) (8k★),
   `claude-code-webui`. These nail the better-than-a-terminal *interface*, but the agent still
   runs wherever it's installed (alongside its filesystem); they are remote *control*, not
   remote *target* with containment.
3. **Agent runs locally, executes on a remote box via an SSH tool (MCP)** — the closest
   *mechanism* match: [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp),
   [AiondaDotCom/mcp-ssh](https://github.com/AiondaDotCom/mcp-ssh) (discovers hosts from
   `~/.ssh/config`), "SSH Manager." No agent on the box — but desktop-bound, self-assembled, a
   *hybrid* (the agent keeps a local FS beside the remote tool), and **zero containment / egress /
   audit story** around it.
4. **Agents operating a *provisioned* environment — cloud or self-hosted — not your existing
   host.**
   [Cursor background agents](https://www.buildfastwithai.com/blogs/cursor-remote-agents-any-device-2026)
   and [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) spin up a
   fresh cloud VM scoped to a repo. [Devin](https://cognition.com/blog/introducing-devin) runs in
   its own cloud sandbox and "cannot access production databases unless you explicitly provide
   credentials." [Coder Tasks](https://coder.com/docs/ai-coder/tasks) runs Claude Code/Goose
   *inside Coder workspaces* on your own infra — the closest enterprise analog, but the agent
   still lives **in** a provisioned workspace (with your repos/creds/internal network), and it
   requires adopting Coder's whole workspace-provisioning platform. None of these operate your
   **pre-existing, unmodified** host over SSH; they all provision the environment the agent runs
   in.

**The gap (the wedge).** No single product combines: the agent + its model credentials + its
egress staying in a **contained box you run**, while it operates **your arbitrary existing host**
over SSH with **nothing installed or credentialed on that host**, through a **chat web UI**,
behind a **central egress allowlist + audit**. The nearest is "SSH-MCP + Claude Desktop," which
the user assembles, keeps a local FS, and has no containment. **ShipIt's positioning is the
security argument restated as product: your remote box never holds the agent, the model creds, or
the LLM egress — it only ever sees brokered commands from a contained ShipIt session.**

**Security precedents from the field** (reinforcing the Security model below): Sourcegraph **Amp**
had an [arbitrary-command-execution-via-prompt-injection vuln](https://embracethered.com/blog/posts/2025/amp-agents-that-modify-system-configuration-and-escape/)
— the exact "agent ingests a hostile instruction and runs it" class this feature must box;
**Devin**'s "no prod access without explicitly provided credentials" mirrors our opt-in scoped-key
posture; and **Cursor**'s silent-local-fallback bug is the basis for invariant #7.

### Remote execution model — and why per-command vs. persistent matters for fail-closed

The two popular SSH-MCP servers
([tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp),
[AiondaDotCom/mcp-ssh](https://github.com/AiondaDotCom/mcp-ssh)) are both **per-command and
stateless** — they shell out to native `ssh`/`scp` per call, with no multiplexing, no persistent
session, and no reconnection logic (tufantunc adds a `--timeout` + kill-hanging-process and a
`--maxChars` command-length cap; neither does pattern allowlisting). That stateless shape **fails
closed for free**: each command *is* an `ssh host 'cmd'` invocation, so an unreachable host makes
`ssh` itself error — there is no notion of a "current target" that could silently revert to local.

The catch: that model is *not* the transparent, live-feeling Remote session we want, and it pays
connection setup on every command. The fix — a multiplexed `ControlMaster`/`ControlPersist`
connection (§4's generated `~/.ssh/config`) — keeps persistence at the **transport** layer while
each command stays a discrete `ssh` that still errors if the master is down. Critically, ssh
itself **never** runs the command locally on a dead connection; Cursor's bug (invariant #7) was an
**application-level** local fallback layered on top of a stateful router. So the rule is precise:
keep per-command `ssh` semantics under a multiplexed transport, and **never** add an application
layer that catches an ssh failure and re-runs anywhere else.

## What already exists (the ~80%)

| Need | Existing subsystem | Status |
|---|---|---|
| Store the private key securely | `SecretStore` (AES-256-GCM at rest, docs/220), set in Settings → Secrets | ✅ reuse |
| Per-session opt-in, default off | Sandbox `capabilities` set (docs/211) — add an `ssh` capability | ✅ reuse (one new member) |
| Permit outbound port 22 to the host | Egress firewall (docs/172) — host-based allowlist, persisted, live-reloadable | ✅ reuse |
| Run `ssh` from chat | The agent's Bash tool | ✅ reuse |
| `ssh` / `ssh-keygen` / `scp` binary | session-worker image | ❌ **missing** — must add `openssh-client` |
| Get the key into the container as a 0600 file | Credential-provisioning (`session-credentials.ts`, `/credentials` symlinks) | ❌ **new** — extend to `~/.ssh`, gated on `ssh` capability |
| Pin `known_hosts`, define host aliases | — | ❌ **new** (part of provisioning) |

## Goals

- The agent can `ssh user@host 'cmd'` and `scp` to a host the user has explicitly authorized,
  driven from chat.
- The private key is stored once (Secrets), never committed, and materialized into the
  container declaratively so it survives container recreation.
- Which hosts are reachable is gated by the existing egress allowlist — SSH does not widen
  the agent's network reach beyond named hosts.
- The capability is **opt-in** and the blast radius of a compromised agent is deliberately
  bounded (see Security model).

## Non-Goals

- **Not** git-over-SSH. Git stays on token-brokered HTTPS (`shipit-git-credential`); this
  feature does not touch the git credential path.
- **Not** an interactive remote shell/TTY surface in the UI. The agent runs discrete commands;
  ad-hoc interactive use remains the local terminal's job.
- **Not** SSH *into* a session container from outside. This is strictly outbound from the
  session to a remote host.
- **Not** a generic "let the agent reach any host." Reachability stays allowlist-gated.

## Design

### 0. The session shape — SSH is a Sandbox capability, and *only* that

SSH belongs to **Sandbox sessions only** (docs/211), never to ordinary repo-backed sessions.
This is a deliberate product decision, not just a default, and it follows from what the two
session shapes are *for*:

- A **repo-backed session** has a specific workflow built around one project: edit the code,
  run the tests, preview, auto-commit/push, open a PR. Everything the orchestrator automates
  assumes that single repo. SSH-to-a-remote-host has nothing to do with that workflow — it is
  not about the bound repo's code or its PR — so offering it there is **confusing**: it dangles
  a remote-host capability in a surface whose whole shape says "work on this repo." There is no
  use case repo-backed SSH serves that a Sandbox session doesn't serve better.
- A **Sandbox session** has the opposite contract: less help with a single project's PR
  workflow (auto-commit/push/PR-card are off), more **freedom** — an empty `/workspace`, the
  agent clones any repo it wants, does scratch/compute work no single repo should own. Driving
  a remote host is exactly that kind of work. SSH is a natural member of the same
  freedom-for-less-automation bargain that already gives Sandbox its `git`/`docker`/`network`
  capabilities.

Three things follow:

- **The opt-in mechanism is free.** Sandbox sessions already carry a **server-authoritative
  `capabilities` set** (`git`, `docker`, `network`), chosen at creation, immutable, and
  impossible for the agent to self-grant. SSH becomes a **fourth capability** (`ssh`, **default
  off**) on that same set — which *is* the "per-session opt-in, default off" the Security model
  (#4) demands, with no new opt-in surface invented. The capability dialog (the `+`
  advanced-session menu → `SandboxDialog`) gains an **"SSH access"** toggle alongside
  GitHub/Docker/Network.
- **Key materialization is platform-owned.** A Sandbox session has an empty `/workspace` and
  deliberately does **not** run `agent.install` (no root `shipit.yaml`; docs/211 "the
  orchestrator stops … running `agent.install`"). So there is no repo-local install snippet to
  materialize the key — it must be provisioned by the platform, gated on the `ssh` capability
  (§4 / `session-credentials.ts`).
- **The network story aligns.** Sandbox already owns egress as a capability (`network`,
  tighten-only). The host allowlist that SSH rides on (§3) composes cleanly: a sealed
  (`network: off`) sandbox can still be granted SSH to a single named host the same way `git`
  adds `github.com` to the lifeline set — SSH adds the allowlisted SSH host.

### 1. The `ssh` binary — the one hard image change

`openssh-client` is absent from the session-worker image. `Dockerfile.session-worker.prod:55`
installs `git curl python3 python3-pip python3-venv make g++ zip unzip ripgrep bubblewrap
gosu` — no ssh. Add `openssh-client` there and in `Dockerfile.session-worker.dev`. This is the
only unavoidable image change; it brings `ssh`, `ssh-keygen`, `ssh-keyscan`, `ssh-agent`,
`scp`, `sftp`.

### 2. The key — reuse Secrets, provisioned server-side (never in agent env)

The user stores their key in Settings → Secrets as `SSH_PRIVATE_KEY` (and optionally
`SSH_KNOWN_HOSTS` for pinned host keys). `SecretStore` already holds it AES-256-GCM at rest
(docs/220).

The repo-backed way to hand a secret to the agent — declaring it `agent: true` in a repo's
`docker-compose.yml` `x-shipit-secrets`, which `secret-resolver.ts` pushes into the worker's
`process.env` before `/agent/start` — **does not apply here**: a Sandbox session is repo-less
and has no `docker-compose.yml` to carry that declaration. Instead, the platform reads
`SSH_PRIVATE_KEY` from `SecretStore` **server-side** and provisions it directly into the
container as a `0600` file when the session's `ssh` capability is granted (§4).

This is strictly better than the env path: `ssh` cannot read a key from an env var anyway (it
needs a `0600` file at a path it or `~/.ssh/config` names), and provisioning server-side means
**the raw key never enters the agent's `process.env`** — it mirrors the credential model where
the GitHub token never reaches the agent (docs/211). The agent can *use* the key (run `ssh`)
but cannot read its bytes out of the environment and exfiltrate them.

### 3. The network path — the egress firewall already permits it, host-based

This is the part that needs essentially no new code. ShipIt's egress firewall (docs/172) is
**host-based, not port-based**:

- **Tier A** (iptables `OUTPUT DROP` + ipset) accepts traffic to a destination IP on **all
  ports** once that IP is pinned into the allow-set. SSH on port 22 rides this exactly like
  HTTPS on 443 does.
- **Tier B** (dnsmasq) answers only allowlisted names and pins the resolved IP into the
  ipset — so allowlisting `prod.example.com` is what makes both the DNS lookup *and* the
  port-22 egress succeed.
- **Tier C** (SNI proxy) only governs port 443. SSH is not intercepted by it; it is governed
  purely by the Tier-A ipset.

So enabling SSH to a host is exactly: **add the host to the egress allowlist.** That path
already exists end-to-end — `POST /api/egress/hosts` (Settings → Egress), persisted in SQLite
(`egress-allowlist-store.ts`), and `reloadEgressSidecars()` (`egress-reload.ts`) re-launches
the resolver + proxy so it takes effect on the running session without a restart. The default
allowlist (`EGRESS_DEFAULT_ALLOWLIST` in `egress-allowlist.ts`) does **not** include arbitrary
hosts, which is correct — the user names their host explicitly.

Connect **by hostname**, not raw IP: Tier B resolves the name and pins the IP. (A raw-IP
target skips DNS; the IP/CIDR would have to be an allowlist entry that Tier A pins directly —
supported by `egress-firewall.ts` IP/CIDR validation, but hostname is the clean path.)

### 4. Materialization — platform-owned credential provisioning

Idle containers are destroyed and re-cloned; anything the agent writes ad-hoc mid-turn
vanishes next session. The secret (SecretStore) and the allowlist entry (SQLite) both persist,
but the `~/.ssh/` contents do not — so materializing the key file is the one piece that needs
a durable, declarative home. With SSH scoped to Sandbox sessions (§0), there is exactly one
real mechanism for this (the old repo-local `agent.install` snippet is gone — a Sandbox runs
no install step):

**Provision `~/.ssh` server-side, gated on the `ssh` capability.** ShipIt provisions
`~/.ssh/{id_ed25519,known_hosts,config}` the same way it already provisions agent credentials.
`Dockerfile.session-worker.prod:248-253` symlinks `~/.claude`/`~/.claude.json`/`~/.codex` from
a `/credentials` mount that `session-credentials.ts` populates per session. The natural
extension: when a Sandbox session has the **`ssh` capability** (§0) granted and an
`SSH_PRIVATE_KEY` secret exists, ShipIt writes `/credentials/.ssh/` (key 0600, `known_hosts`, a
generated `config`) and symlinks `~/.ssh`. The key never touches the workspace, never enters the
agent's env, mirrors the established credential model, and survives container recreation.

**Prototyping the loop, before that provisioning is built.** The first proof — that
`openssh-client` + the egress allowlist + a key actually connect — does **not** require the
provisioning above. Stand it up inside a **Sandbox session**: add `openssh-client` to the image,
allowlist a throwaway host, and have the agent materialize the key ad-hoc for the session
(e.g. write `~/.ssh/id_ed25519` from a pasted key in one turn). It is ephemeral — it vanishes on
container recreation — but that is fine for a proof, and it exercises the same Sandbox session
shape the shipped feature uses, so nothing is throwaway-scoped to a session type we're not
keeping. Durable provisioning is then the one platform addition that turns the proof into a
feature.

A generated `~/.ssh/config` lets the agent use stable aliases and enforces safe defaults:

```
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.ssh/known_hosts
```

## Security model

**This is the crux of the feature, not an afterthought.** ShipIt's entire containment story
— the egress firewall (docs/172), the untrusted-input posture (CLAUDE.md; docs/176, docs/201),
the repo-trust gate (docs/178), sandbox sessions (docs/211) — exists to box in an agent that
may be **prompt-injected** by content it reads (a hostile README, a fetched web page, an issue
body). Handing that agent an SSH key to a host — especially the production box — is the
single highest-value pivot we can give an attacker: a malicious instruction the agent ingests
could turn "set up SSH" into "ssh prod and exfiltrate / tamper." The host allowlist already
bounds *which* hosts; the rest of the boundary must be designed deliberately:

1. **Dedicated, scoped key — never the user's personal key.** The key provisioned into the
   container should be minted for this purpose and revocable independently. Compromise of a
   session must not compromise the user's broader SSH identity.

2. **Lock the remote side (defense that does not depend on the agent behaving).** The strongest
   control lives on the host, not in the container:
   - A forced command in `authorized_keys`
     (`command="/usr/local/bin/shipit-remote",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 …`)
     so the key can only invoke a bounded, audited entry point — even a fully compromised agent
     cannot run arbitrary commands.
   - Or a restricted user / `rbash` / a jailed account with a narrow sudoers allowlist.
   - This is the recommended posture for the ShipIt prod box specifically.

3. **Pin `known_hosts`; never `StrictHostKeyChecking=no`.** Provide the host's public key
   (the `SSH_KNOWN_HOSTS` secret / provisioned `known_hosts`) so a hijacked DNS answer inside
   the allowlist cannot MITM the session. `accept-new` is the weakest acceptable fallback for a
   throwaway host during prototyping, not for prod.

4. **Per-session opt-in, default off — as a Sandbox capability (§0).** SSH capability is not
   ambient. It is the **`ssh` capability** on a Sandbox session's server-authoritative
   `capabilities` set (docs/211): chosen at creation in the capability dialog, default off,
   immutable, and impossible for the agent to self-grant. The key is provisioned (§4)
   only when that capability is granted, so it lands only where the user intends it. An
   untrusted repo opened casually is an ordinary session with no `ssh` capability and gets no
   key. This reuses the existing opt-in machinery rather than inventing a new flag.

5. **The ShipIt-prod-from-ShipIt loop deserves its own fence.** A contained agent reaching the
   host that runs the platform containing it is a genuine reflexive risk. Treat prod as the
   canonical case for the forced-command restriction (#2) and the narrowest possible key
   scope. The `ssh` capability lives in the same server-authoritative family as ops semantics
   (docs/128-ops-session, docs/162-ops-remediation-sessions) — so the prod loop can be gated as
   tightly as an ops/sandbox grant rather than handed to an ordinary session.

6. **Auditability.** Remote actions should be reconstructable: the agent's `ssh` invocations
   are already in the chat transcript / tool log; the forced-command entry point (#2) should
   log on the host side too.

7. **Fail closed on connection loss (Remote-session invariant).** In a Remote session, where
   execution is transparently routed to the host, a dropped/degraded SSH connection must make
   commands **error**, never silently fall back to running in ShipIt's local container. This is
   not hypothetical: Cursor shipped exactly this bug — a background subagent
   [silently fell back to local-machine execution when its SSH connection degraded](https://forum.cursor.com/t/security-background-subagent-silently-falls-back-to-local-machine-execution-when-ssh-remote-connection-degrades/160392).
   A command the agent believes is running on the box but is actually running locally (with the
   container's own credentials/egress) is both a correctness and a containment failure. The
   managed connection — a multiplexed `ControlMaster`/`ControlPersist` connection set up from the
   generated `~/.ssh/config` (§4), which also amortizes per-command setup so remote execution
   feels live — must treat "no live connection to host X" as a hard error surfaced to the agent,
   with an explicit, user-visible reconnect. There is no implicit local fallback.

None of this blocks the feature — it shapes it. The minimal prototype may use a throwaway host
with `accept-new` to prove the loop, but the **shipped** feature must carry items 1–5 (and a
Remote session must also carry 7).

## Implementation sequencing

1. **Minimal enabler (prove the loop), in a Sandbox session.** Add `openssh-client` to both
   Dockerfiles; create a Sandbox session, allowlist a throwaway host, and materialize a key
   ad-hoc in-turn (ephemeral — §4). Verify `ssh` connects end-to-end. No new platform surface,
   and it already runs in the Sandbox shape the feature ships on, so nothing is throwaway.
2. **First-class provisioning on a Sandbox session.** Add the **`ssh` capability** to the
   Sandbox `capabilities` set (data model + `SandboxDialog` toggle, mirroring git/docker/
   network); provision the key durably in `session-credentials.ts` + a `/credentials/.ssh`
   symlink gated on that capability; generate `~/.ssh/config`. This turns the proof into a
   feature.
3. **Remote-hosts config + security defaults.** A small "remote hosts" concept (host, user,
   key-secret name, pinned host key) that auto-allowlists the host and provisions the alias;
   ship with the forced-command guidance and prod fence.

## Key files

- `docker/Dockerfile.session-worker.prod` (line ~55 apt install; lines 248–253 credential
  symlink pattern) and `docker/Dockerfile.session-worker.dev` — add `openssh-client`; model
  `~/.ssh` provisioning on the existing `/credentials` symlinks.
- `src/server/orchestrator/secret-store.ts` — `SecretStore` holds `SSH_PRIVATE_KEY`; read
  server-side at provisioning time (no `agent: true`/`process.env` env-push path; §2).
- `src/server/orchestrator/session-credentials.ts` — home of key provisioning (write
  `/credentials/.ssh`, symlink `~/.ssh`), gated on the session's `ssh` capability.
- **Sandbox capability plumbing (§0)** — `src/server/shared/types/domain-types/session.ts`
  (`SessionCapabilities` + `DEFAULT_SANDBOX_CAPABILITIES` + `normalizeCapabilities`),
  `database.ts` (the `capabilities` column already exists; no new migration), and
  `src/client/components/SandboxDialog.tsx` — add the `ssh` capability + the "SSH access"
  toggle alongside git/docker/network.
- `src/server/orchestrator/egress-allowlist.ts`, `api-routes-egress.ts`, `egress-reload.ts`,
  `egress-allowlist-store.ts` — the host-allowlist path SSH rides on (no change expected;
  confirm port-22 reachability needs no port-specific rule).
- `src/server/shipit-docs/secrets.md`, `environment.md`, `sandbox-session.md` — agent-facing
  docs for storing the key, the egress requirement, and the `ssh` Sandbox capability.

## Open questions

- **Session shape — resolved (§0):** SSH is a **Sandbox-only** capability; repo-backed sessions
  do not get it (it has no place in their repo/PR workflow and would only confuse). This also
  retires the old `agent.install`-timing question — a Sandbox runs no install step, so the key
  is provisioned server-side, not by a repo snippet.
- **Per-session opt-in mechanism — resolved (§0):** the **`ssh` capability** on a Sandbox
  session, set server-authoritatively at creation, default off. This reuses the existing
  `capabilities` machinery (docs/211) instead of inventing a session flag, `shipit.yaml` field,
  or account-level registry. (A per-host "remote hosts" registry remains a *Phase 3* refinement
  layered on top — it auto-allowlists the host and provisions the alias — not the opt-in gate.)
- **Key format.** Standardize on `id_ed25519`; confirm older `id_rsa` keys are still supported
  for users who have them.
- **`scp`/`sftp` scope.** In-scope for file transfer, but interacts with the forced-command
  restriction (#2) — a forced command blocks `scp`. Decide whether transfer needs a second,
  separately-scoped key or a different remote-side allowance.
