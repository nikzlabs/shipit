# Checklist — SSH hosts

Design only so far. All questions in `requirements.md` are resolved; implementation is unblocked.

- [ ] `openssh-client` in both session-worker Dockerfiles
- [ ] `CredentialStore.sshHosts` + key generation + public-line derivation
- [ ] Browser-only host CRUD routes; Settings → Services section
- [ ] `session.sshHosts` grant column, `setSshHosts`, Session settings dialog multi-select
- [ ] Worker SSH agent socket + `/agent-ops/ssh/{identities,sign}` relay
- [ ] Orchestrator sign endpoint with grant gate and audit line
- [ ] Provision `~/.ssh/{config,known_hosts,<alias>.pub}`; `SSH_AUTH_SOCK` in worker env
- [ ] First-connect host key capture: worker reports the `known_hosts` line, orchestrator stores it, fingerprint in Settings + one persisted card
- [ ] Per-session egress allowlist entry on grant / removal on revoke
- [ ] Persisted change card on grant edit
- [ ] Prompt fragment + `shipit-docs/ssh.md`
- [ ] Tests listed in `plan.md`
