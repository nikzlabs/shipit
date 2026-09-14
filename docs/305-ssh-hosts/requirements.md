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

## Open questions

- Host key verification. Should the user paste the server's public host key to pin it when
  adding the host, or should the first connection accept the host key and record the
  fingerprint for the user to confirm?
- Audit. Should each SSH connection produce a line in the session transcript, or only a line
  in the orchestrator log?

## Resolved questions

- 2026-09-14 — Where does the private key come from? ShipIt generates it (req 5). Import of
  an existing key is not in scope; a shared personal key would break the one-key-per-host
  rule.
- 2026-09-14 — Which sessions can be granted a host? Any session kind (req 6). The general
  case is a repo session that deploys to its own server.
- 2026-09-14 — What happens to docs/228? Superseded (req 7). Transparent command routing is
  dropped; explicit `ssh` is what every harness already does and it fails closed.
