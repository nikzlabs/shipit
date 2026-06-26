---
issue: https://linear.app/shipit-ai/issue/SHI-215
title: Remote SSH from a session
description: Let a session's agent run commands on a remote host over SSH, using an SSH key from Secrets, with the egress allowlist gating which hosts are reachable.
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

## What already exists (the ~80%)

| Need | Existing subsystem | Status |
|---|---|---|
| Store the private key securely | `SecretStore` (AES-256-GCM at rest, docs/220), set in Settings → Secrets | ✅ reuse |
| Get the key to the agent | `agent: true` in `x-shipit-secrets` → pushed into the agent's `process.env` | ✅ reuse |
| Permit outbound port 22 to the host | Egress firewall (docs/172) — host-based allowlist, persisted, live-reloadable | ✅ reuse |
| Run `ssh` from chat | The agent's Bash tool | ✅ reuse |
| `ssh` / `ssh-keygen` / `scp` binary | session-worker image | ❌ **missing** — must add `openssh-client` |
| Materialize the key to `~/.ssh/id_ed25519` (0600) | — | ❌ **new** — needs a declarative home |
| Pin `known_hosts`, define host aliases | — | ❌ **new** (part of materialization) |

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

### 1. The `ssh` binary — the one hard image change

`openssh-client` is absent from the session-worker image. `Dockerfile.session-worker.prod:55`
installs `git curl python3 python3-pip python3-venv make g++ zip unzip ripgrep bubblewrap
gosu` — no ssh. Add `openssh-client` there and in `Dockerfile.session-worker.dev`. This is the
only unavoidable image change; it brings `ssh`, `ssh-keygen`, `ssh-keyscan`, `ssh-agent`,
`scp`, `sftp`.

### 2. The key — reuse Secrets, surface as an `agent: true` secret

The user stores their key in Settings → Secrets as `SSH_PRIVATE_KEY` (and optionally
`SSH_KNOWN_HOSTS`). A repo opts the agent in by declaring it `agent: true` in its
`docker-compose.yml`:

```yaml
x-shipit-secrets:
  - { name: SSH_PRIVATE_KEY, agent: true }
  - { name: SSH_KNOWN_HOSTS, agent: true }   # pinned host keys (see Security)
```

`secret-resolver.ts` already routes `agent: true` values into `agentValues`, writes
`.shipit/.env.agent` (mode 0600), and `ContainerSessionRunner.tryPushAgentSecrets()` pushes
them into the worker's `process.env` before each `/agent/start`. So the agent sees
`process.env.SSH_PRIVATE_KEY`. **But `ssh` cannot read a key from an env var** — it needs a
`0600` file at a path it (or `~/.ssh/config`) names. Hence the materialization step (§4).

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

### 4. Materialization must be declarative (ephemeral containers)

Idle containers are destroyed and re-cloned; anything the agent writes ad-hoc mid-turn
vanishes next session. The secret (SecretStore) and the allowlist entry (SQLite) both persist,
but the `~/.ssh/` contents do not — so materializing the key file is the one piece that needs
a **declarative** home. Two options, sequenced minimal-first:

**Option A — `agent.install` snippet (quick, repo-local).** The target repo's `shipit.yaml`
carries an install step that writes the file:

```yaml
agent:
  install:
    - mkdir -p ~/.ssh && chmod 700 ~/.ssh
    - printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
    - printf '%s\n' "$SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts && chmod 644 ~/.ssh/known_hosts
```

Pros: no platform change beyond the image. Cons: the snippet lives in every repo that wants
it, and — **open question (§Open questions)** — `agent.install` (run by `install-controller.ts`
before the first turn) may not see the `agent: true` secret, because the agent-env push
happens just before `/agent/start`, *after* install runs. If install does not see it, Option A
needs the install timing changed or the value delivered another way, which pushes toward B.

**Option B — first-class credential provisioning (clean, platform-owned).** ShipIt provisions
`~/.ssh/{id_ed25519,known_hosts,config}` the same way it already provisions agent credentials.
`Dockerfile.session-worker.prod:248-253` symlinks `~/.claude`/`~/.claude.json`/`~/.codex` from
a `/credentials` mount that `session-credentials.ts` populates per session. The natural
extension: when an `SSH_PRIVATE_KEY` secret is present and the session has SSH enabled, write
`/credentials/.ssh/` (key 0600, `known_hosts`, a generated `config`) and symlink `~/.ssh`. The
key never touches the workspace, mirrors the established credential model, survives recreation,
and needs no per-repo shell. This is the recommended end state; Option A is the prototype to
prove the loop first.

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

4. **Per-session opt-in, default off.** SSH capability is not ambient. A session must be
   explicitly enabled for remote SSH (e.g. a session/repo flag), so the key is provisioned only
   where the user intends it. An untrusted repo opened casually gets no key.

5. **The ShipIt-prod-from-ShipIt loop deserves its own fence.** A contained agent reaching the
   host that runs the platform containing it is a genuine reflexive risk. Treat prod as the
   canonical case for the forced-command restriction (#2) and the narrowest possible key
   scope, and consider gating it behind ops-session semantics (docs/128-ops-session,
   docs/162-ops-remediation-sessions) rather than an ordinary session.

6. **Auditability.** Remote actions should be reconstructable: the agent's `ssh` invocations
   are already in the chat transcript / tool log; the forced-command entry point (#2) should
   log on the host side too.

None of this blocks the feature — it shapes it. The minimal prototype may use a throwaway host
with `accept-new` to prove the loop, but the **shipped** feature must carry items 1–5.

## Implementation sequencing

1. **Minimal enabler (prove the loop).** Add `openssh-client` to both Dockerfiles; document
   the Option-A `agent.install` materialization (resolving the install-vs-secret timing open
   question); rely on the existing egress allowlist UI. Verify end-to-end against a throwaway
   host. No new platform surface.
2. **First-class provisioning (Option B).** Move materialization into `session-credentials.ts`
   + a `/credentials/.ssh` symlink; generate `~/.ssh/config`; add the per-session opt-in flag.
3. **Remote-hosts config + security defaults.** A small "remote hosts" concept (host, user,
   key-secret name, pinned host key) that auto-allowlists the host and provisions the alias;
   ship with the forced-command guidance and prod fence.

## Key files

- `docker/Dockerfile.session-worker.prod` (line ~55 apt install; lines 248–253 credential
  symlink pattern) and `docker/Dockerfile.session-worker.dev` — add `openssh-client`; model
  `~/.ssh` provisioning on the existing `/credentials` symlinks.
- `src/server/orchestrator/secret-resolver.ts` / `secret-store.ts` — `agent: true` →
  `process.env` path for the key; no change expected beyond reuse.
- `src/server/orchestrator/session-credentials.ts` — home of Option B (provision
  `/credentials/.ssh`, symlink `~/.ssh`).
- `src/server/orchestrator/egress-allowlist.ts`, `api-routes-egress.ts`, `egress-reload.ts`,
  `egress-allowlist-store.ts` — the host-allowlist path SSH rides on (no change expected;
  confirm port-22 reachability needs no port-specific rule).
- `src/server/session/install-controller.ts` + `src/server/shared/shipit-config.ts`
  (`agent.install`) — Option A materialization, and the env-timing open question.
- `src/server/shipit-docs/secrets.md`, `environment.md`, `shipit-yaml.md` — agent-facing docs
  for storing the key, the egress requirement, and the materialization step.

## Open questions

- **Does `agent.install` see `agent: true` secrets?** The agent-env push runs just before
  `/agent/start`; install runs earlier. If not, Option A must change install timing or deliver
  the key differently — which is an argument for Option B. **Verify before relying on Option A.**
- **Per-session opt-in mechanism.** A session flag, a repo `shipit.yaml` field, or an
  account-level "remote hosts" registry? Leaning toward an explicit per-session/host enable so
  the key is provisioned narrowly.
- **Key format.** Standardize on `id_ed25519`; confirm older `id_rsa` keys are still supported
  for users who have them.
- **`scp`/`sftp` scope.** In-scope for file transfer, but interacts with the forced-command
  restriction (#2) — a forced command blocks `scp`. Decide whether transfer needs a second,
  separately-scoped key or a different remote-side allowance.
