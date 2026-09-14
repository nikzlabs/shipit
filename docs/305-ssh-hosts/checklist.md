# Checklist — SSH hosts

All twelve requirements are resolved and the design is reviewed. Implementation is in `src/server/orchestrator/ssh-hosts.ts`, `ssh-provision.ts`, `services/ssh.ts`, `api-routes-ssh.ts` and `src/server/session/ssh-agent-socket.ts`.

## Image and container
- [x] `openssh-client` and a `~/.ssh` → `/credentials/.ssh` symlink in both session-worker Dockerfiles
- [x] `entrypoint.sh`: recreate the `.ssh` symlink under the read-only home tmpfs; create `/run/shipit` owned by the worker uid
- [x] `SSH_AUTH_SOCK` in the worker env; confirm each of the five harnesses' shell tool and the terminal inherit it (no harness-specific SSH hook)

## Registry and grant
- [x] `CredentialStore.sshHosts` + ed25519 key generation + `authorized_keys` line derivation; public projection for every read
- [x] Browser-only destination CRUD routes; Settings → Integrations section, beside GitHub and Linear
- [x] `session.sshHosts` grant column, `setSshHosts`, Session settings dialog multi-select; edit route not behind `requireSandbox`
- [x] Persisted change card on grant edit — the existing `SessionSettingsChangeCard` with an `ssh-hosts` scope, which plan.md names

## Signing path
- [x] Worker SSH agent socket: identities, `session-bind@openssh.com` held per connection, sign relayed with the bind; everything else refused
- [x] Orchestrator sign endpoint: grant gate, bind verification, `is_forwarding` refusal, host-key pin (record on first bind, refuse mismatch + warning card), userauth-only data with matching session id and user, per-session rate/concurrency bound, one audit line per attempt with outcome and refusal reason
- [x] Fingerprint card on first bind and warning card on mismatch, both persisted (docs/188 recipe)

## Reachability
- [x] Provision `~/.ssh/{config,known_hosts,<alias>.pub}` on grant; rewrite on grant change; `known_hosts` from the recorded key
- [x] Per-session egress allowlist entry for a hostname on grant / removal on revoke — derived from the durable grant in `resolveEgressConfig`, so a revoke cannot leave an orphaned row
- [x] IP destinations derived from durable grants into the firewall's CIDR input at every container creation, reconciled live on grant edit
- [x] Network-off sandbox: SSH grants composed explicitly into the effective policy (names and IPs)

## Docs and prompt
- [x] Static prompt fragment (points at `~/.ssh/config`) + `shipit-docs/ssh.md` (aliases, revocation limits, local-mode caveat) + the wiki page
- [x] Tests listed in `plan.md`, each signer rule proven red alone

## Not in this feature
- The SFTP-backed remote file tree from docs/228 phase 3 stays a separate future item.
- Importing an existing private key (requirements.md req 5 puts generation in scope, not import).
