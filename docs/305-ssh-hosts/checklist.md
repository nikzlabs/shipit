# Checklist — SSH hosts

Design only so far. One open question in `requirements.md` (req 10 wording) blocks implementation code.

## Image and container
- [ ] `openssh-client` and a `~/.ssh` → `/credentials/.ssh` symlink in both session-worker Dockerfiles
- [ ] `entrypoint.sh`: recreate the `.ssh` symlink under the read-only home tmpfs; create `/run/shipit` owned by the worker uid
- [ ] `SSH_AUTH_SOCK` in the worker env; confirm each of the five harnesses' shell tool and the terminal inherit it (no harness-specific SSH hook)

## Registry and grant
- [ ] `CredentialStore.sshHosts` + ed25519 key generation + `authorized_keys` line derivation; public projection for every read
- [ ] Browser-only destination CRUD routes; Settings → Services section
- [ ] `session.sshHosts` grant column, `setSshHosts`, Session settings dialog multi-select; edit route not behind `requireSandbox`
- [ ] Persisted change card on grant edit (docs/188 recipe: typed field, column, rehydration, `CARD_MESSAGE_FIELDS`, round-trip tests)

## Signing path
- [ ] Worker SSH agent socket: identities, `session-bind@openssh.com` held per connection, sign relayed with the bind; everything else refused
- [ ] Orchestrator sign endpoint: grant gate, bind verification, `is_forwarding` refusal, host-key pin (record on first bind, refuse mismatch + warning card), userauth-only data with matching session id and user, per-session rate/concurrency bound, one audit line per signature
- [ ] Fingerprint card on first bind and warning card on mismatch, both persisted (docs/188 recipe)

## Reachability
- [ ] Provision `~/.ssh/{config,known_hosts,<alias>.pub}` on grant; rewrite on grant change; `known_hosts` from the recorded key
- [ ] Per-session egress allowlist entry for a hostname on grant / removal on revoke
- [ ] IP destinations derived from durable grants into the firewall's CIDR input at every container creation, reconciled live on grant edit
- [ ] Network-off sandbox: SSH grants composed explicitly into the effective policy (names and IPs)

## Docs and prompt
- [ ] Static prompt fragment (points at `~/.ssh/config`) + `shipit-docs/ssh.md` (aliases, revocation limits, local-mode caveat)
- [ ] Tests listed in `plan.md`, each signer rule proven red alone
