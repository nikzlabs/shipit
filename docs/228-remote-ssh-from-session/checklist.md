# Checklist — Remote SSH from a session

Design doc only so far; nothing implemented. Tracks SHI-215.

## Phase 1 — Minimal enabler (prove the loop)
- [ ] Add `openssh-client` to `Dockerfile.session-worker.prod` and `.dev`
- [ ] Verify whether `agent.install` sees `agent: true` secrets (env-push timing open question)
- [ ] Document key materialization to `~/.ssh/id_ed25519` (0600) + pinned `known_hosts`
- [ ] Confirm egress allowlist opens port 22 to an allowlisted host with no port-specific change
- [ ] End-to-end: agent `ssh`'s to an allowlisted throwaway host from chat

## Phase 2 — First-class provisioning (Option B)
- [ ] Provision `/credentials/.ssh` + symlink `~/.ssh` in `session-credentials.ts`
- [ ] Generate `~/.ssh/config` with safe defaults (`StrictHostKeyChecking yes`, `IdentitiesOnly yes`)
- [ ] Per-session opt-in flag (default off)

## Phase 3 — Remote-hosts config + security defaults
- [ ] "Remote hosts" concept (host, user, key-secret, pinned host key) that auto-allowlists
- [ ] Dedicated scoped key guidance; forced-command `authorized_keys` recipe
- [ ] Deliberate fence for the ShipIt-prod-from-ShipIt loop
- [ ] Update `src/server/shipit-docs/{secrets,environment,shipit-yaml}.md`
