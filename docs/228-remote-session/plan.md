---
issue: https://linear.app/shipit-ai/issue/SHI-215
title: Remote session — operate a remote host over SSH from chat
description: A session whose execution environment is a remote host reached over SSH. The agent operates the box from chat while the agent, model, and credentials stay contained in ShipIt — nothing is installed or credentialed on the host.
---

# 228 — Remote session

## Overview

A **Remote session** is a session whose **execution environment is a remote host**, reached over
SSH. There is no local project: the agent operates the box directly — runs commands, inspects
state, edits remote files — exactly as you would after `ssh`-ing in and running an agent there.
The difference is *where the agent lives*: the agent, the model, and its credentials stay inside
ShipIt's **contained container**, and only *commands* travel over SSH to the host. Nothing is
installed on the box and no agent/model credentials are stored on it.

This is the in-ShipIt replacement for the thing many of us do by hand today: open a local
terminal, `ssh` to a VPS / prod box, and run an agent (or just poke around) for setup and
debugging. The user describes intent in chat ("restart the service", "tail the logs and find why
it's 502-ing"); the agent operates the host; the output renders inline. It pulls a workflow that
currently lives outside ShipIt back onto the surface.

> **Scope note.** This doc supersedes the earlier "SSH *from* a session" framing (a Sandbox with a
> local workspace that could *also* `ssh host 'cmd'`). That lighter shape is at most a lesser
> cousin; the feature we are designing is the Remote session — the host *is* the workspace.

## Motivation

Today the only way to drive a remote host from ShipIt is to leave it — a local terminal, `ssh` by
hand. That violates product principle §1 ("the user does not leave the surface"). The user
explicitly wants to do remote setup/debugging — including on the ShipIt prod box — from the web
UI, in a better interface than a raw terminal.

The status quo it replaces (`ssh` to the box and run an agent on it) has two real costs a Remote
session removes:

- **You install the agent and store its credentials on the box.** The agent binary, the model API
  key, and the agent's own network egress all land on a production machine. A Remote session keeps
  all of that in ShipIt's contained container; the box only ever receives brokered commands.
- **It happens in a terminal, with no history, no shared surface, no containment.** A Remote
  session gives it ShipIt's chat transcript, central egress allowlist, and audit.

So the Remote session is not just "more convenient" — against the manual baseline it is a
**security improvement**, not only a UX one (see Security model).

## Competitive landscape

Surveyed June 2026. The axis that matters is **where the agent (and its model credentials / LLM
egress) runs, and whether the remote box must host it.** Existing tools fall into four camps:

1. **Agent installed *on* the remote box** — you SSH in and run the agent there.
   [Warp](https://docs.warp.dev/agent-platform/cli-agents/claude-code) "Warpifies" an SSH session
   and runs Claude Code on the remote (its file tree needs Warp's SSH extension);
   [Claude Code's Desktop app SSH hosts](https://code.claude.com/docs/en/desktop-quickstart)
   **auto-install Claude Code on the remote machine** on first connect; the hand-rolled
   `ssh box "claude -p …"` + `tmux` pattern is widely blogged. **The agent, its credentials, and
   its LLM egress all live on the box** — exactly what a Remote session avoids.
2. **Web/mobile UI that *remote-controls* a Claude session** —
   [Omnara](https://www.omnara.com/), [Happy](https://happy.engineering/),
   [CloudCLI / claude-code-ui](https://github.com/siteboon/claudecodeui) (8k★), `claude-code-webui`.
   These nail the better-than-a-terminal *interface*, but the agent still runs wherever it's
   installed (beside its filesystem); they are remote *control*, not a contained remote *target*.
3. **Agent runs locally, executes on a remote box via an SSH tool (MCP)** — the closest
   *mechanism* match: [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp),
   [AiondaDotCom/mcp-ssh](https://github.com/AiondaDotCom/mcp-ssh) (discovers hosts from
   `~/.ssh/config`), "SSH Manager." No agent on the box — but desktop-bound, self-assembled, a
   *hybrid* (the agent keeps a local FS beside the remote tool), and **zero containment / egress /
   audit story**.
4. **Agents operating a *provisioned* environment — cloud or self-hosted — not your existing
   host.** [Cursor background agents](https://www.buildfastwithai.com/blogs/cursor-remote-agents-any-device-2026)
   and [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) spin up a
   fresh cloud VM scoped to a repo; [Devin](https://cognition.com/blog/introducing-devin) runs in
   its own cloud sandbox and "cannot access production databases unless you explicitly provide
   credentials"; [Coder Tasks](https://coder.com/docs/ai-coder/tasks) runs Claude Code/Goose
   *inside Coder workspaces* on your own infra (closest enterprise analog, but the agent lives
   **in** a provisioned workspace and you adopt Coder's whole platform). None operate your
   **pre-existing, unmodified** host over SSH; they all provision the environment the agent runs in.

**The gap (the wedge).** No single product combines: the agent + its model credentials + its
egress staying in a **contained box you run**, while it operates **your arbitrary existing host**
over SSH with **nothing installed or credentialed on that host**, through a **chat web UI**, behind
a **central egress allowlist + audit**. The nearest is "SSH-MCP + Claude Desktop," which the user
assembles, keeps a local FS, and has no containment. **ShipIt's positioning is the security
argument restated as product: your remote box never holds the agent, the model creds, or the LLM
egress — it only ever sees brokered commands from a contained ShipIt session.**

**Security precedents from the field** (reinforcing the Security model below): Sourcegraph **Amp**
had an [arbitrary-command-execution-via-prompt-injection vuln](https://embracethered.com/blog/posts/2025/amp-agents-that-modify-system-configuration-and-escape/)
— the exact "agent ingests a hostile instruction and runs it" class this feature must box;
**Devin**'s "no prod access without explicitly provided credentials" mirrors our opt-in scoped-key
posture; and **Cursor**'s silent-local-fallback bug is the basis for invariant #7.

## The model

### A new session kind, in the ops/sandbox family

A Remote session is a third **server-authoritative session kind** — `kind = "remote"` — alongside
`"ops"` and `"sandbox"` (docs/211, docs/128). Like those, it is a regular session with the
repo-bound project automation stripped out, set immutably at creation and never inferred from
workspace files (so an agent cannot self-promote). It goes further than Sandbox: a Sandbox has an
empty *local* `/workspace` the agent clones into; a Remote session has **no local workspace at
all** — execution targets the host.

| Surface | Remote session |
|---|---|
| Local `/workspace` | **None** — there is no local project; execution is on the host |
| Preview / compose | Off |
| Auto-commit / auto-push / PR card | Off (gated on `kind`) |
| `RELEASES` / `NEW_PROJECT` prompt fragments | Dropped |
| Sidebar | Own group + badge (like Host / Sandbox) |
| Chat history | On — persists in the DB as for any session |

### Transparent remote execution — the whole-session contract

Execution is **transparently routed to the host**: the agent's command tool runs on the remote,
and the agent is *told once at creation* "your shell is host X." This is deliberately a
**whole-session contract**, not a per-command decision — that is what keeps it coherent and avoids
the local/remote split-brain a hybrid (some commands local, some remote) would create. The agent
still **knows** it is operating a remote host (good for reasoning and for audit); it simply does
not construct `ssh` invocations itself or manage keys, hosts, or the connection.

The agent's intent flows the same way as always (chat → agent → command); only the *substrate*
the command lands on is remote. Command working-directory and environment continuity across calls
is expected (the agent should be able to `cd` and have the next command see it), which the
connection model below must preserve.

### File access

With no local FS, the agent's file operations must target the remote. Two options, sequenced:

- **Shell-only (MVP).** No rich local file tools; the agent reads/edits over the connection with
  ordinary tools (`cat`, `sed`, `rg`, `tee`). Simplest; nothing new to build beyond command
  routing. The ShipIt file tree is hidden or shows a thin remote `ls`.
- **SFTP/sshfs-backed file tools + tree (later).** Back Read/Write/Edit/Grep and the file tree
  with SFTP (or an `sshfs` mount of a chosen remote root) so the rich tools and the tree work
  against the host. More work; a clear Phase 2+.

## How it works — mechanism (reuses existing subsystems)

The hard parts are mostly already in ShipIt. SSH needs three things — the binary, the key, and a
network path — each mapping onto an existing subsystem; the fourth piece (command routing) is the
genuinely new work.

### 1. The `ssh` binary — the one hard image change

`openssh-client` is absent from the session-worker image (`Dockerfile.session-worker.prod:55`
installs `git curl python3 … gosu` — no ssh). Add `openssh-client` there and in
`Dockerfile.session-worker.dev`. It brings `ssh`, `ssh-keygen`, `ssh-keyscan`, `ssh-agent`, `scp`,
`sftp`. This is the only unavoidable image change.

### 2. The key — reuse Secrets, provisioned server-side (never in agent env)

The user stores a **dedicated, scoped** key in Settings → Secrets as `SSH_PRIVATE_KEY` (and the
host's public key as `SSH_KNOWN_HOSTS`). `SecretStore` already holds it AES-256-GCM at rest
(docs/220). The platform reads it **server-side** and provisions it into the container as a `0600`
file, modeled on the existing credential symlink pattern (`Dockerfile.session-worker.prod:248-253`
symlinks `~/.claude` etc. from a `/credentials` mount that `session-credentials.ts` populates per
session): write `/credentials/.ssh/{id_ed25519,known_hosts,config}` and symlink `~/.ssh`.

This is strictly better than an env-var path: `ssh` needs a key *file* anyway, and provisioning
server-side means **the raw key never enters the agent's `process.env`** — it mirrors the
credential model where the GitHub token never reaches the agent (docs/211). The agent can *use*
the key but cannot read its bytes and exfiltrate them.

A generated `~/.ssh/config` hides the plumbing and enforces safe defaults:

```
Host target
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.ssh/known_hosts
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

### 3. The network path — the egress firewall already permits it, host-based

ShipIt's egress firewall (docs/172) is **host-based, not port-based**. Tier A (iptables
`OUTPUT DROP` + ipset) accepts traffic to a pinned IP on **all** ports, so SSH on 22 rides it
exactly like HTTPS on 443; Tier B (dnsmasq) answers only allowlisted names and pins the resolved
IP; Tier C (SNI proxy) only governs 443 and does not touch SSH. So enabling a host is exactly
**add it to the egress allowlist** — an existing end-to-end path (`POST /api/egress/hosts`,
persisted in SQLite, live-reloaded by `reloadEgressSidecars()`), no port-specific rule. Connect
**by hostname** so Tier B resolves and pins the IP. A Remote session creation flow should
auto-allowlist its target host.

### 4. Command routing + connection model (the new work)

The agent's command tool must execute on the host. Mechanism is an implementation choice (e.g.
each command → `ssh target -- 'cd <tracked-cwd> && <cmd>'` with the wrapper tracking cwd/env, or a
persistent remote shell fed over the connection); the **contract** is fixed: transparent,
whole-session, with cwd/env continuity.

The transport is a **multiplexed `ControlMaster`/`ControlPersist`** connection (the `~/.ssh/config`
above): one persistent connection, so per-command setup is amortized and remote execution *feels
live*, while each command stays a discrete `ssh` invocation. This must **fail closed** — see
Security invariant #7.

## Security model

**This is the crux of the feature, not an afterthought.** ShipIt's containment story — the egress
firewall (docs/172), the untrusted-input posture (CLAUDE.md; docs/176, docs/201), the repo-trust
gate (docs/178), sandbox sessions (docs/211) — exists to box in an agent that may be
**prompt-injected** by content it reads. A Remote session is the highest-value pivot we can hand an
attacker: a malicious instruction the agent ingests could turn "check the logs" into "exfiltrate /
tamper." The framing that makes this acceptable: a Remote session is **more** contained than the
manual `ssh`-and-run-an-agent-on-the-box baseline it replaces (the box never holds the agent, its
model creds, or its egress), and **less** contained than a normal repo session. The boundary is
designed deliberately:

1. **Dedicated, scoped key — never the user's personal key.** Minted for this purpose and revocable
   independently; a compromised session must not compromise the user's broader SSH identity.

2. **Lock the remote side (defense that does not depend on the agent behaving).** The strongest
   control lives on the host: a forced command in `authorized_keys`
   (`command="/usr/local/bin/shipit-remote",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 …`)
   bounding the key to an audited entry point, or a restricted user / `rbash` / jailed account with
   a narrow sudoers allowlist. Recommended posture for the ShipIt prod box specifically.

3. **Pin `known_hosts`; never `StrictHostKeyChecking=no`.** Provide the host's public key so a
   hijacked DNS answer inside the allowlist cannot MITM the session. `accept-new` is the weakest
   acceptable fallback for a throwaway host during prototyping, not for prod.

4. **Opt-in, default off — it is its own session kind.** A Remote session is never ambient: the
   user creates `kind = "remote"` deliberately, naming the host, and the key is provisioned only
   then. An untrusted repo opened casually is an ordinary session and gets no key.

5. **The ShipIt-prod-from-ShipIt loop deserves its own fence.** A contained agent reaching the host
   that runs the platform containing it is a genuine reflexive risk. Treat prod as the canonical
   case for the forced-command restriction (#2) and the narrowest possible key scope; gate it with
   ops-grade semantics (docs/128, docs/162) rather than handing it to an ordinary user flow.

6. **Auditability.** Remote actions must be reconstructable: the agent's commands are in the chat
   transcript / tool log; the forced-command entry point (#2) should log on the host side too.

7. **Fail closed on connection loss.** Because execution is transparently routed to the host, a
   dropped/degraded connection must make commands **error**, never silently fall back to running in
   ShipIt's local container. This is not hypothetical: Cursor shipped exactly this bug — a
   background subagent
   [silently fell back to local-machine execution when its SSH connection degraded](https://forum.cursor.com/t/security-background-subagent-silently-falls-back-to-local-machine-execution-when-ssh-remote-connection-degrades/160392).
   A command the agent believes runs on the box but actually runs locally (with the container's own
   credentials/egress) is both a correctness and a containment failure.

   The mechanism makes this tractable. The popular SSH-MCP servers
   ([tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp),
   [AiondaDotCom/mcp-ssh](https://github.com/AiondaDotCom/mcp-ssh)) are per-command, stateless
   native-`ssh` shell-outs — which **fail closed for free**: each command *is* an `ssh host 'cmd'`,
   so an unreachable host makes `ssh` itself error, with no "current target" to revert to. A
   multiplexed `ControlMaster` keeps that per-command-`ssh` semantics under a persistent transport
   (still fails closed; ssh never runs the command locally on a dead connection). Cursor's bug was
   an **application-level** local fallback layered on a stateful router — so the rule is precise:
   keep per-command `ssh` semantics under a multiplexed transport, and **never** add an application
   layer that catches an ssh failure and re-runs anywhere else.

None of this blocks the feature — it shapes it. A throwaway-host prototype may use `accept-new`,
but the shipped feature must carry items 1–7.

## Implementation sequencing

1. **Prove the loop.** Add `openssh-client` to both Dockerfiles. Create a throwaway-host target,
   allowlist it, and route a single command over a multiplexed `ssh` connection from a session.
   Verify it connects, reuses the connection, and **errors** (does not run locally) when the host
   is unreachable.
2. **The Remote session kind.** `kind = "remote"` + creation flow (capability dialog: host, user,
   key secret, pinned host key) that auto-allowlists the host and provisions `~/.ssh` server-side
   from `SecretStore`; transparent command routing with cwd/env continuity; ops-style turn-offs;
   sidebar group + tab gating; system-prompt variant ("your shell is host X"). Shell-only file
   access.
3. **Security defaults + ergonomics.** Forced-command `authorized_keys` recipe + the prod fence;
   dedicated-key guidance; SFTP/sshfs-backed file tools + remote file tree; a saved "remote hosts"
   registry (host, user, key-secret, pinned host key) to make repeat targets one-click.

## Key files

- `docker/Dockerfile.session-worker.prod` (line ~55 apt install; lines 248–253 credential symlink
  pattern) and `docker/Dockerfile.session-worker.dev` — add `openssh-client`; model `~/.ssh`
  provisioning on the existing `/credentials` symlinks.
- `src/server/orchestrator/secret-store.ts` — `SecretStore` holds `SSH_PRIVATE_KEY`; read
  server-side at provisioning time (no `process.env` env-push path).
- `src/server/orchestrator/session-credentials.ts` — provision `/credentials/.ssh` + the generated
  `~/.ssh/config`; symlink `~/.ssh`. Gated on `kind === "remote"`.
- **Session-kind plumbing** — `src/server/shared/types/domain-types/session.ts` (`kind: "remote"`),
  `sessions.ts` (`fromRow`/`toRow`, `setKind`), `services/templates*.ts` (creation path modeled on
  the ops/sandbox templates), `ws-handlers/post-turn.ts` (skip auto-commit/PR for `kind`).
- **Command routing** — the worker's command/Bash execution path (`src/server/session/…`): route
  through the multiplexed `ssh` connection for a Remote session, with cwd/env continuity and the
  fail-closed contract.
- `src/server/orchestrator/egress-allowlist.ts`, `api-routes-egress.ts`, `egress-reload.ts` — the
  host-allowlist path SSH rides on; auto-allowlist the target at creation (no port-specific rule).
- `src/server/orchestrator/agent-instructions.ts` + `prompts/` — a Remote-session system-prompt
  variant ("your shell is host X; no local workspace").
- `src/client/components/` — creation dialog (host/user/key/pinned-host-key), sidebar group + badge,
  tab gating (no Preview/PR), a derived "Remote session — operating host X" banner.
- `src/server/shipit-docs/` — document the Remote session for the in-container agent.

## Open questions

- **Command-routing mechanism.** Per-command `ssh target -- 'cd <cwd> && <cmd>'` with wrapper-side
  cwd/env tracking, vs a persistent remote shell fed over the connection. The contract (transparent,
  cwd/env continuity, fail-closed) is fixed; the mechanism is open.
- **File access depth for v1.** Shell-only (cat/sed/rg over the connection) vs SFTP/sshfs-backed
  file tools + remote tree. Leaning shell-only for the MVP.
- **Is it its own `kind`, or a Sandbox sub-mode?** Proposed here as its own `kind = "remote"`
  because "no local workspace, execution-is-remote" is a materially different contract than a
  Sandbox's empty-but-local workspace. Revisit if the two converge.
- **Key format.** Standardize on `id_ed25519`; confirm older `id_rsa` keys still work for users who
  have them.
- **`scp`/`sftp` and the forced command.** A forced command (#2) blocks `scp`. Decide whether file
  transfer needs a second, separately-scoped key or a different remote-side allowance.
- **Prod fence mechanics.** Exactly how the ShipIt-prod target is gated (ops-grade semantics? a
  separate approval?) vs an ordinary remote host.
