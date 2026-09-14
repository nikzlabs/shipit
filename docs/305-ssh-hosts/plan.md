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
GitHub and Linear tokens, encrypted at rest (docs/220). Compose secrets come from `SecretStore`
only (`service-manager-setup.ts:322`). The agent env loader does read `CredentialStore`, but
through explicit collectors — MCP env and service credential routes
(`secret-resolver.ts:170`, `collectAccountAgentEnv`) — so a dedicated `sshHosts` field is
outside it as long as no collector is ever taught about it. So the key lives there, and
signing happens there.

Where "never" holds, and where it does not: it holds for a containerized session, whose
mounts are the per-session credentials subtree, the workspace, and the state dirs
(`container-lifecycle.ts`). It does not hold in local runtime mode, where the agent is an
in-process child of the orchestrator with no mount boundary (docs/150 "Local-mode
compatibility"); and a destination that is the ShipIt host itself hands the agent a path to
the store from the outside. Both are stated in `shipit-docs/ssh.md`. Two more rules follow:
browser CRUD responses and settings reads return a public projection of a host entry (id,
label, address, port, user, public line, fingerprint) — "browser-only" restricts callers, it
does not redact a returned object — and no log line ever carries a host record or a signing
input.

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

- **Worker side.** A Unix socket server speaking the SSH agent protocol. Per socket
  connection (one per `ssh` process) it accepts `SSH_AGENTC_REQUEST_IDENTITIES` (relayed to
  `GET /agent-ops/ssh/identities`), the `session-bind@openssh.com` extension (held for the
  life of that connection), and `SSH_AGENTC_SIGN_REQUEST` (relayed to `POST /agent-ops/ssh/sign`
  together with the held bind), and returns `SSH_AGENT_FAILURE` for everything else. The
  worker holds no key and enforces nothing; it is routing convenience, not a boundary.
- **Orchestrator side — the signer contract.** `POST /sessions/:id/ssh/sign` is where every
  check lives, because the docs/201 bridge-IP guard identifies the *session*, not the process
  inside it (`api-container-guard.ts:187`): the agent can call this route directly, and the
  design permits that. The endpoint is stateless; the bind travels with each sign request.
  It signs only when all of the following hold, and refuses otherwise:
  1. The session's grant includes the destination whose key is requested.
  2. A `session-bind@openssh.com` message is present, its `is_forwarding` is false, and its
     host-key signature over the session identifier verifies (PROTOCOL.agent: `string hostkey,
     string session identifier, string signature, bool is_forwarding`). The agent cannot forge
     this: it needs the server's host private key, so a valid bind proves a real key exchange
     with that server.
  3. The bind's host key equals the destination's recorded host key. If the destination has
     none yet, this bind records it (TOFU, req 9) — from the server's own signature, never from
     a file in the container — and a persisted card shows the fingerprint. A later mismatch is
     refused and a persisted warning card says so.
  4. The data to sign parses as an SSH userauth publickey request — `string session id, byte
     50, string user, string "ssh-connection", string "publickey", bool true, string alg, string
     pubkey` — whose session id equals the bind's and whose `user` equals the destination's
     configured user. Nothing else is ever signed, so the endpoint is not a signing oracle.
  5. A per-session rate and concurrency bound is not exceeded.
  Then it signs with `node:crypto` (ed25519: `crypto.sign(null, data, key)`, blob
  `string "ssh-ed25519" || string sig`). Every attempt, signed or refused, logs one line:
  session, destination, user, time, outcome, and for a refusal which rule above failed
  (req 10). That line records an *authentication attempt*; the orchestrator never learns
  whether the server accepted it, so a "signed" line followed by a failing `ssh` points at
  the server side (`authorized_keys`, restricted user), never at the signer.

What this contract buys, stated without overclaiming: the private key stays secret (req 3);
the key authenticates only to the pinned host, as the configured user — a relay through
another machine cannot produce that host's signature; agent forwarding is refused at the
signer, whatever `ForwardAgent` says in an editable config. What it does not do: it cannot
stop the agent from running any command the server allows once authenticated (host-side
restricted user), and revoking a grant stops *new* authentications only — an already
authenticated connection continues until it closes (the firewall accepts established flows,
`init-firewall.sh:104`).
- **Why not a brokered `ssh` shim.** It would need `openssh-client` in the orchestrator image,
  stream stdin and terminals over two HTTP hops, and reimplement `scp`, `rsync`, and git
  transport one by one. The agent-socket path needs none of that (req 2).

| Option | Agent can read key? | Harness-agnostic? | scp / git / rsync work? | Fails closed? | New binaries |
|---|---|---|---|---|---|
| **A. Agent socket + orchestrator signing** (chosen) | No — only challenges and signatures cross | Yes — plain `ssh` in PATH + `~/.ssh/config` | Yes | Yes — an unreachable host makes `ssh` error | `openssh-client` in the worker image |
| B. Brokered `ssh` shim (orchestrator runs ssh) | No | Only for the commands the shim reimplements | No — each needs its own shim | Yes | `openssh-client` in the orchestrator image; stdin/tty over two HTTP hops |
| C. Key file in `/credentials` (docs/228 as written) | **Yes** — same uid (docs/138, docs/150) | Yes | Yes | Yes | `openssh-client` in the worker image |
| D. Repo secret in Settings → Secrets | **Yes** — `agent: true`, or a service that prints its env (docs/087) | Yes | Yes | Yes | `openssh-client` in the worker image |

## Harness-agnostic by construction (req 2)

`openssh-client` is added to `docker/Dockerfile.session-worker.prod` and `.dev`, together
with a `~/.ssh` → `/credentials/.ssh` symlink, which does not exist today
(`Dockerfile.session-worker.prod:115` symlinks only the agent config dirs). Under the
read-only home tmpfs the entrypoint must recreate that symlink like the others
(`entrypoint.sh:159`), and must create `/run/shipit` owned by the worker uid, since `/run` is
a tmpfs (`container-hardening.ts:54`) and the socket lives there. `SSH_AUTH_SOCK` goes into
the worker environment, which all five harness adapters and the terminal copy
(`agents/*/adapter.ts`, `terminal.ts`); whether each harness's *shell tool* inherits it
unchanged is a per-harness check in the checklist, not an assumption. The orchestrator
writes into the per-session credentials scaffold (`session-credentials.ts`):

```
Host prod
  HostName prod.example.com
  User deploy
  Port 22
  IdentityAgent /run/shipit/ssh-agent.sock
  IdentityFile ~/.ssh/prod.pub
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new   # the signer's recorded key is what counts (req 9)
  UserKnownHostsFile ~/.ssh/known_hosts
  ForwardAgent no
```

`IdentityFile` may name a `.pub` when the private half is in an agent, so only public material
is on disk; `IdentitiesOnly` keeps a session with several grants from offering unrelated keys
and exhausting the server's attempt limit. The host key is learned by the signer from the
server's own `session-bind` signature (signer contract, step 3), never from `known_hosts`,
which the agent can write. Once recorded, the orchestrator provisions that key into
`known_hosts` for every granted session and the signer refuses any other, so a changed host
key fails at both ends. Before the first connection there is no line yet: the client's own
prompt is answered by `accept-new` semantics on that first connect only, and the recorded key
is what counts thereafter. No `ControlMaster`: multiplexing adds nothing a requirement asks
for, and it keeps an authenticated channel alive across grant revocation. One command, one
authentication, one audit line. `SSH_AUTH_SOCK` is also set in the worker's environment so `ssh user@host`,
`git clone git@…`, `scp`, and `rsync` work without the alias; every harness and the terminal
inherit it. The agent can edit these files, which only weakens its own protection.

Node generates the key with `crypto.generateKeyPairSync("ed25519")` and derives the
`authorized_keys` line (`ssh-ed25519 ` + base64 of `string "ssh-ed25519" || string raw32`);
verified with `ssh-keygen -l`. No new dependency. Node cannot parse the OpenSSH private-key
format, which is one reason import is out of scope (req 5).

## Scoping what the key can do

Scope comes from three places:

- **The signer contract** above: signing only for a userauth request bound to the
  destination's recorded host key, as its configured user, never for a forwarded connection.
  This is what stops use of the key against another machine; "one key per destination" alone
  does not, since the public key can be installed anywhere.
- **One key per destination** (req 11), so revoking or rotating one destination touches
  nothing else.
- **The egress firewall.** Tier A's ipset ACCEPT has no port match
  (`docker/egress-sidecar/init-firewall.sh:117`), so an allowlisted host is reachable on 22
  like on 443, and a non-allowlisted one is dropped. The Tier C "allow this host?" card
  cannot fire for SSH (it lives in the SNI proxy), so attaching a host adds it to the
  session's egress allowlist at grant time, never on demand. For a **network-off sandbox**
  the ordinary per-session host path is discarded (`egress-allowlist.ts:285`,
  `userHostsExcluded`), so SSH grants must compose into the effective policy explicitly —
  names into the lifeline base, IPs into the CIDR input — the way `git` adds `github.com`
  (docs/211). That is the one deliberate exception, and `shipit-docs/ssh.md` says so.

### Tailnet destinations (Tailscale on the ShipIt host)

Reachability works at the routing layer: the VPS runs `tailscaled` natively in kernel mode
(`deployment/vps/tailscale.sh`), session containers sit on a per-session Docker bridge
(`container-lifecycle.ts`, `Driver: "bridge"`), Docker masquerades bridge traffic out of any
host interface including `tailscale0`, and Tailscale's default netfilter rules accept forwarded
traffic leaving on `tailscale0`. Peers see the connection as coming from the ShipIt host node,
subject to the tailnet's ACLs for that node. Verify on the host with `iptables -S ts-forward`.

Two things do not work today and are implementation items here:

- **Names.** The host runs `tailscale up --accept-dns=false`, so MagicDNS names never reach a
  session; the Tier B resolver forwards only allowlisted public domains to `publicUpstreams`
  (`egress-dns.ts`). A tailnet peer is addressed by its stable `100.x.y.z` address.
- **IP literals.** The per-session allowlist is name-based: an address lands in the Tier A
  ipset only through dnsmasq's `ipset=/<domain>/` pinning when a query for that name is
  answered. `ssh 100.83.12.47` issues no query, so the packet is dropped. An SSH host entry
  whose address is an IP literal (req 12) is therefore *derived from the durable grant* into
  the firewall's `EGRESS_ALLOWED_CIDRS` input on every container creation (today fed by
  GitHub's ranges only, `egress-firewall-install.ts:78`) and reconciled live on a grant edit.
  A one-time `ipset add` is not enough: `init-firewall.sh:68` destroys and rebuilds the sets
  whenever the firewall reinstalls, so a grant applied only to the running namespace would
  vanish on recreation.

**Tailscale SSH caveat.** If a peer runs Tailscale SSH, it authenticates the *node*, not a
key. Every session on the ShipIt host looks like that node, so a Tailscale SSH policy that
grants the ShipIt host node access would bypass the per-host key and leave the per-session
egress allowlist as the only gate. Keep key-based `sshd` auth on peers and do not grant the
ShipIt host node in Tailscale SSH policies.

Firewall admission is all this section establishes; it does not by itself prove host routing
or tailnet ACL reachability for a given peer.

Residual risk, unchanged from docs/228: a prompt-injected agent can run destructive commands
on the host. Bound it on the host side with a restricted user or a forced command; the
authorized_keys line ShipIt shows carries `no-agent-forwarding,no-port-forwarding,no-X11-forwarding`.

## Grant model (req 4, req 6)

- **Host entry** (account-wide, `CredentialStore.sshHosts`, req 11): id, label, address
  (hostname or IP, req 12), port, user, private key (PKCS8 PEM, never leaves the store),
  public line, recorded host key once learned.
  Browser-only CRUD routes, never `containerAccessible`. Settings → Services, beside GitHub
  and Linear. Settings reads that reach the agent (docs/299) expose only the public line and
  fingerprint.
- **Session grant** `session.sshHosts: string[]`, server-authoritative like `capabilities`
  (docs/211), edited in the Session settings dialog for every kind (docs/279 pattern). The
  edit route is its own; it must not sit behind `requireSandbox`
  (`services/session-settings.ts:57`), which guards the capability editor. Attaching applies
  live: durable write → per-session egress entry (name, or IP into the CIDR input) → provision
  `~/.ssh/{config,known_hosts,<alias>.pub}` → persisted change card
  (`SessionSettingsChangeCard`). Identities are answered per request, so the socket needs no
  restart. Revoking removes all of that and stops new signing; it does not close a
  connection already authenticated.
- **Prompt.** A *static* fragment: "SSH destinations granted to this session are listed as
  `Host` blocks in `~/.ssh/config`; use `ssh <alias>`; ShipIt holds the key." The granted
  list itself never enters the system prompt — the prompt variants are frozen at module load
  (CLAUDE.md, Prompts) and a mutable list would break the cache contract. Plus
  `src/server/shipit-docs/ssh.md`.

## What docs/228 becomes (req 7)

Sandbox session (docs/211) + a host grant + the prompt line. No `kind = "remote"`, no
transparent command routing, no per-harness shell hook. Explicit `ssh host 'cmd'` fails closed
by construction (docs/228 invariant 7) and cwd continuity is the agent's own `cd … &&`. The
SFTP-backed remote file tree from docs/228 phase 3 stays a separate future item.

## Key files

- `docker/Dockerfile.session-worker.prod`, `.dev` — `openssh-client`, `~/.ssh` symlink;
  `docker/session-worker/entrypoint.sh` — symlink under read-only home, `/run/shipit`.
- `src/server/session/ssh-agent-socket.ts` (new) — agent-protocol socket; holds the
  session-bind per connection and relays it with each sign request.
- `src/server/orchestrator/egress-firewall-install.ts`, `egress-allowlist.ts` — IP grants into
  the CIDR input; SSH grants composed into a network-off sandbox's policy.
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

- Agent protocol framing and refusal of every message that is not identities, bind, or sign.
- Signer contract, each rule red alone: no bind → refuse; `is_forwarding` → refuse; bad
  host-key signature → refuse; host key ≠ recorded → refuse + warning card; data that is not a
  userauth request, or a different session id, or a different user → refuse; first bind
  records the key. Signature round trip verified with `ssh-keygen -Y verify`.
- Grant gate: a session without the host gets `SSH_AGENT_FAILURE`; an ungranted key id 403s;
  a direct call from the container to its own session's route is accepted, a cross-session
  one is not.
- IP grant survives container recreation (present in the firewall inputs, not only the live set).
- Network-off sandbox with an SSH grant reaches that destination and nothing else new.
- The private key appears in no settings read, no compose env file, no `/credentials` path.
- Provisioned config is rewritten on grant change; allowlist entry added and removed.
