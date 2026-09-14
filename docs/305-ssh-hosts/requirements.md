---
issue: planning#563
title: SSH hosts
description: The agent runs commands on a remote server over SSH from any session, on any harness, and the private key never enters the session container.
---

# SSH hosts

1. From a session, the agent can run commands on a remote server over SSH.
2. This works on every harness ShipIt supports with no per-harness integration.
3. The agent can never read the private key. Not through the compose file, not through a
   compose service, not through the session container's filesystem, not through a settings
   read.
4. The key is not a repo secret. It has its own place in the UI, separate from
   Settings → Secrets.
5. ShipIt generates the key. The user installs the public key on the server.
6. Any session kind can be granted a host: repo-backed, sandbox, or ops.
7. This feature supersedes the Remote session design (docs/228-remote-session). A remote
   session is a sandbox session with a host granted.
8. Carried from docs/228: nothing is installed on the remote host, and no agent or model
   credential is stored there. The host only receives commands.
9. The first connection to a host accepts and records the server's host key. The fingerprint
   is shown in the host entry and in a transcript card so the user can compare it with the
   server. Later connections require the recorded key.
10. Each SSH authentication attempt is recorded as one line in the orchestrator log with
    enough detail to debug a failure: session, destination, user, time, and whether ShipIt
    signed or refused, with the reason for a refusal. No transcript card per connection; the
    commands are already in the transcript as the agent's tool calls.

11. The registry is a list of destinations, account-wide for the ShipIt instance. Each
    destination has its own generated key. A session is granted one or more destinations.
12. A destination's address may be a hostname or an IP address. An IP destination is
    reachable from a granted session even though no DNS lookup happens for it.

## Open questions

- How does ShipIt learn a destination's real host key (req 9)? The first `session-bind`
  proves a key exchange with whoever holds the supplied host key, not with the configured
  address, so before the first real connection a granted session can pin a key of its own.
  The private key is not exposed; the effect is that the destination stops working for every
  granted session until "forget host key" is used, with a wrong fingerprint shown meanwhile.
  Candidates: the orchestrator scans the address itself (`ssh-keyscan`, needs
  `openssh-client` in the orchestrator image) and pins only a matching key; accept the risk as
  stated and keep the current narrowing; or the user confirms the fingerprint card before
  signing starts.

## Resolved questions

- 2026-09-14 — Does req 10 mean confirmed connections or authentication attempts? The user
  does not mind which; the logging must make debugging easy. Req 10 reworded to one line per
  authentication attempt with the signer's outcome and refusal reason, since server
  acceptance is invisible to ShipIt.

- 2026-09-14 — What does the registry hold? Destinations, one key each (req 11). Shared keys
  were declined because one key would then open several servers.
- 2026-09-14 — May a destination be an IP address? Yes, hostname or IP (req 12). Needed for
  Tailscale peers, whose MagicDNS names do not resolve inside a session.

- 2026-09-14 — How is the host key verified? Accept on first connect and show the fingerprint
  (req 9). Pasting the host public key to pin it was declined as one more manual step per
  host.
- 2026-09-14 — Where is each connection recorded? Orchestrator log only (req 10). A
  per-connection transcript card was declined as noise.

- 2026-09-14 — Where does the private key come from? ShipIt generates it (req 5). Import of
  an existing key is not in scope; a shared personal key would break the one-key-per-host
  rule.
- 2026-09-14 — Which sessions can be granted a host? Any session kind (req 6). The general
  case is a repo session that deploys to its own server.
- 2026-09-14 — What happens to docs/228? Superseded (req 7). Transparent command routing is
  dropped; explicit `ssh` is what every harness already does and it fails closed.
