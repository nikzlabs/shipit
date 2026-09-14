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
- [x] Orchestrator sign endpoint: grant gate, bind verification, `is_forwarding` refusal, host-key pin (record on first bind, refuse mismatch + warning card), userauth-only data with matching session id and user, per-session rate bound, one audit line per attempt with outcome and refusal reason
- [x] Fingerprint card on first bind and warning card on mismatch, both persisted (docs/188 recipe)

## Reachability
- [x] Provision `~/.ssh/{config,known_hosts,<alias>.pub}` on grant; rewrite on grant change; `known_hosts` from the recorded key
- [x] Per-session egress allowlist entry for a hostname on grant / removal on revoke — derived from the durable grant in `resolveEgressConfig`, so a revoke cannot leave an orphaned row
- [x] IP destinations derived from durable grants into the firewall's CIDR input at every container creation, reconciled live on grant edit
- [x] Network-off sandbox: SSH grants composed explicitly into the effective policy (names and IPs)

## Docs and prompt
- [x] Static prompt fragment (points at `~/.ssh/config`) + `shipit-docs/ssh.md` (aliases, revocation limits, local-mode caveat) + the wiki page
- [x] Tests listed in `plan.md`, each signer rule proven red alone

## The design's own guarantees, after review

An independent review (run `21b663a1-c44f-4371-8058-6d35e38e1ef0`) found two claims in `plan.md` that the mechanism cannot support. `plan.md` now states what the bind proves and what each check leaves open.

- [ ] **First-use trust.** Nothing ties the caller-supplied host key to the configured address, so a granted session can pin a key it minted itself before the first real connection. Recording is deferred until every other rule has passed and "forget host key" recovers; closing it is the open question in `requirements.md`.
- [x] **`is_forwarding`.** The flag is an unsigned byte the caller controls. The check stays for honest and accidental forwarding; `plan.md` no longer claims it holds against a hostile in-container agent, and states that the residual reaches nothing new.

## Fixed after review, each with a guard proven red alone

- [x] `~/.ssh` provisioning followed an agent-planted symlink, deleting another session's credentials and writing into the global credentials root
- [x] The `.pub` file carried `authorized_keys` options, which OpenSSH's identity loader rejects — the feature could not authenticate at all
- [x] `publickey-hostbound-v00@openssh.com`, which every OpenSSH 8.9+ client prefers, was refused by the parser; now accepted, with the appended host key checked against the bound one
- [x] The `algorithm` field was unchecked, making the signer a constrained oracle
- [x] A revoked IP destination's firewall rule was never withdrawn
- [x] An open agent connection could block worker shutdown indefinitely
- [x] Attacker-influenceable values reached the whitespace-delimited audit line unescaped

## Not in this feature
- The SFTP-backed remote file tree from docs/228 phase 3 stays a separate future item.
- Importing an existing private key (requirements.md req 5 puts generation in scope, not import).
- An end-to-end test against a real `sshd`. The container has no `openssh-server` and no root to install one, so protocol conformance is argued from OpenSSH's sources and checked against the real `ssh-keygen` loader and the pinned client binary. That is weaker than a handshake and is why two of the defects above survived the first round of tests.
