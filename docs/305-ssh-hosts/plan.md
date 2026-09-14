---
issue: planning#563
title: SSH hosts — design
description: An SSH agent socket in the session container, signing in the orchestrator, so any harness can use a host's key without ever reading it.
---

# SSH hosts — design

Implements [requirements.md](requirements.md). Requirements are cited as `(req N)`.

## The one constraint that decides the shape

The agent must never read the private key (req 3). Two places that look usable are not:

- **Settings → Secrets** is per repo and resolves only from `SecretStore` into compose
  services. The agent edits the compose file, so it can mark any secret `agent: true` or make
  a service print its environment (docs/087 "Limitations: agent controls the code").
- **A `0600` file under `/credentials`**, which docs/228 proposed, is readable: the agent CLI,
  the worker, and the terminal all run as the same uid (docs/138, docs/150). Docs/228's claim
  that such a file is "usable but not readable" was wrong.

The only store the agent cannot reach is the orchestrator's `CredentialStore`, which holds the
GitHub and Linear tokens, encrypted at rest (docs/220). The compose resolver never consults it
(verified at `service-manager-setup.ts:322`, which reads `secretStore.loadSecrets` only). So
the key lives there, and signing happens there.

## Mechanism: SSH agent protocol, signing brokered like the GitHub token

```
agent CLI (any harness)      session container                          orchestrator
ssh prod 'df -h'  ───────▶ openssh-client
                           ~/.ssh/config: Host prod
                             HostName prod.example.com
                             IdentityAgent /run/shipit/ssh-agent.sock
                           TCP prod:22 ── egress Tier A/B (host allowlisted) ──▶ prod host
                           ◀── server auth challenge ───────────────────────────
                           ssh → socket: SIGN_REQUEST(pubkey, challenge)
                           worker ssh-agent-socket.ts (holds NO key)
                             POST /agent-ops/ssh/sign ── relay ────────────▶ POST /sessions/:id/ssh/sign
                                                                            grant check: session.sshHosts ∋ host
                                                                            sign with key from CredentialStore
                                                                            audit line
                           ◀── signature ──────────────────────────────────
                           ssh sends signature ──▶ prod accepts ──▶ command runs
```

The only bytes that cross into the container are the public key, the host key, and
signatures. This is the shape `shipit-git-credential` already has
(`session/agent-shim/git-credential.ts` → worker relay `/agent-ops/git/credential` →
orchestrator, gated by `gitCredentialAllowed(session)` in `pr-target.ts`).

- **Worker side.** A Unix socket server speaking the SSH agent protocol. It answers
  `SSH_AGENTC_REQUEST_IDENTITIES` (relayed to `GET /agent-ops/ssh/identities`) and
  `SSH_AGENTC_SIGN_REQUEST` (relayed to `POST /agent-ops/ssh/sign`) and returns
  `SSH_AGENT_FAILURE` for everything else — no add, remove, lock, or extension. The worker
  runs as the agent's uid, which is fine: it holds nothing worth reading.
- **Orchestrator side.** `POST /sessions/:id/ssh/sign` checks that the session's grant
  includes the key, signs with `node:crypto` (ed25519: `crypto.sign(null, data, key)`, blob
  `string "ssh-ed25519" || string sig`), logs one line per signature with session, host,
  and time (one signature is one connection; that log line is the whole audit, req 10),
  and returns. Container-accessible only through the relay, so the docs/201
  bridge-IP guard applies.
- **Why not a brokered `ssh` shim.** It would need `openssh-client` in the orchestrator image,
  stream stdin and terminals over two HTTP hops, and reimplement `scp`, `rsync`, and git
  transport one by one. The agent-socket path needs none of that (req 2).

## Harness-agnostic by construction (req 2)

`openssh-client` is added to `docker/Dockerfile.session-worker.prod` and `.dev` — the only
image change. The orchestrator writes into the per-session credentials scaffold
(`session-credentials.ts`, the image symlinks `~/.ssh` → `/credentials/.ssh`):

```
Host prod
  HostName prod.example.com
  User deploy
  Port 22
  IdentityAgent /run/shipit/ssh-agent.sock
  IdentityFile ~/.ssh/prod.pub
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new   # first connect records the key (req 9)
  UserKnownHostsFile ~/.ssh/known_hosts
  ForwardAgent no
  ControlMaster auto
  ControlPath /run/shipit/cm-%C
  ControlPersist 10m
```

`IdentityFile` may name a `.pub` when the private half is in an agent, so only public material
is on disk. The host key is learned on the first connection (req 9): the worker reads the new
`known_hosts` line after a successful sign, reports it to the orchestrator, which stores it on
the host entry, shows the fingerprint in Settings, and emits one persisted transcript card via
`emitChatCard`. From then on the orchestrator provisions that line into `known_hosts` for
every session, so a changed host key fails the connection. `SSH_AUTH_SOCK` is also set in the worker's environment so `ssh user@host`,
`git clone git@…`, `scp`, and `rsync` work without the alias; every harness and the terminal
inherit it. The agent can edit these files, which only weakens its own protection.

Node generates the key with `crypto.generateKeyPairSync("ed25519")` and derives the
`authorized_keys` line (`ssh-ed25519 ` + base64 of `string "ssh-ed25519" || string raw32`);
verified with `ssh-keygen -l`. No new dependency. Node cannot parse the OpenSSH private-key
format, which is one reason import is out of scope (req 5).

## Scoping what the key can do

The agent protocol does not reveal the destination host, so scope comes from two other places:

- **One key per host entry**, so a key is trusted by exactly one server.
- **The egress firewall.** Tier A's ipset ACCEPT has no port match
  (`docker/egress-sidecar/init-firewall.sh:117`), so an allowlisted host is reachable on 22
  like on 443, and a non-allowlisted one is dropped. The Tier C "allow this host?" card
  cannot fire for SSH (it lives in the SNI proxy), so attaching a host adds it to the
  session's egress allowlist at grant time, never on demand.
- **Later hardening.** OpenSSH ≥ 8.9 sends `session-bind@openssh.com` to the agent with the
  server's host key before signing; the orchestrator can refuse to sign unless it matches the
  pinned key. This also makes any agent forwarding useless.

Residual risk, unchanged from docs/228: a prompt-injected agent can run destructive commands
on the host. Bound it on the host side with a restricted user or a forced command; the
authorized_keys line ShipIt shows carries `no-agent-forwarding,no-port-forwarding,no-X11-forwarding`.

## Grant model (req 4, req 6)

- **Host entry** (account-wide, `CredentialStore.sshHosts`): id, label, hostname, port, user,
  private key (PKCS8 PEM, never leaves the store), public line, optional pinned host key.
  Browser-only CRUD routes, never `containerAccessible`. Settings → Services, beside GitHub
  and Linear. Settings reads that reach the agent (docs/299) expose only the public line and
  fingerprint.
- **Session grant** `session.sshHosts: string[]`, server-authoritative like `capabilities`
  (docs/211), edited in the Session settings dialog for every kind (docs/279 pattern).
  Attaching applies live: durable write → per-session egress allowlist entry → provision
  `~/.ssh/{config,known_hosts,<alias>.pub}` → persisted change card
  (`SessionSettingsChangeCard`). Identities are answered per request, so the socket needs no
  restart.
- **Prompt.** A fragment lists granted hosts: "host `prod` is reachable as `ssh prod`; ShipIt
  holds the key." Plus `src/server/shipit-docs/ssh.md`.

## What docs/228 becomes (req 7)

Sandbox session (docs/211) + a host grant + the prompt line. No `kind = "remote"`, no
transparent command routing, no per-harness shell hook. Explicit `ssh host 'cmd'` fails closed
by construction (docs/228 invariant 7) and cwd continuity is the agent's own `cd … &&`. The
SFTP-backed remote file tree from docs/228 phase 3 stays a separate future item.

## Key files

- `docker/Dockerfile.session-worker.prod`, `.dev` — `openssh-client`.
- `src/server/session/ssh-agent-socket.ts` (new) — agent-protocol socket, relays to the worker.
- `src/server/session/agent-ops-routes.ts` — `/agent-ops/ssh/identities`, `/agent-ops/ssh/sign`.
- `src/server/orchestrator/ssh-hosts.ts` (new) — key generation, public-line derivation, signing.
- `src/server/orchestrator/credential-store.ts` — `sshHosts` field.
- `src/server/orchestrator/api-routes-ssh.ts` (new) — browser-only host CRUD; session grant
  edit; container-relayed identities/sign.
- `src/server/orchestrator/sessions.ts`, `shared/types/domain-types/session.ts` — `sshHosts`.
- `src/server/orchestrator/session-credentials.ts` — provision `~/.ssh/*`.
- `src/server/orchestrator/egress-allowlist.ts` — per-session entry on grant.
- `src/server/orchestrator/agent-instructions.ts`, `prompts/` — hosts fragment.
- `src/client/components/Settings/ServicesPanel.tsx`, `SessionSidebar/SessionSettingsDialog.tsx`.
- `src/server/shipit-docs/ssh.md`.

## Tests

- Agent protocol framing and refusal of every non-sign message.
- Signature round trip verified with `ssh-keygen -Y verify` against the derived public key.
- Grant gate: a session without the host gets `SSH_AGENT_FAILURE`; an ungranted key id 403s.
- The private key appears in no settings read, no compose env file, no `/credentials` path.
- Provisioned config is rewritten on grant change; allowlist entry added and removed.
