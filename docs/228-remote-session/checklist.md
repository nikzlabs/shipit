# Checklist — Remote session

Design doc only so far; nothing implemented. Tracks SHI-215.

## Phase 1 — Prove the loop
- [ ] Add `openssh-client` to `Dockerfile.session-worker.prod` and `.dev`
- [ ] Route a single command over a multiplexed `ssh` (`ControlMaster`) connection from a session
- [ ] Confirm the egress allowlist opens port 22 to an allowlisted host with no port-specific change
- [ ] Verify fail-closed: an unreachable host makes the command **error**, never run locally

## Phase 2 — The Remote session kind
- [ ] `kind = "remote"` in the data model + `fromRow`/`toRow`/`setKind`
- [ ] Creation flow (host, user, key secret, pinned host key) that auto-allowlists the target
- [ ] Provision `~/.ssh/{id_ed25519,known_hosts,config}` server-side from `SecretStore`, gated on `kind`
- [ ] Transparent command routing with cwd/env continuity (the whole-session contract)
- [ ] Ops-style turn-offs (no preview/PR/auto-commit), sidebar group + tab gating
- [ ] Remote-session system-prompt variant ("your shell is host X; no local workspace")
- [ ] Shell-only file access for v1

## Phase 3 — Security defaults + ergonomics
- [ ] Dedicated scoped-key guidance + forced-command `authorized_keys` recipe
- [ ] Deliberate fence for the ShipIt-prod-from-ShipIt loop
- [ ] SFTP/sshfs-backed file tools + remote file tree
- [ ] Saved "remote hosts" registry for one-click repeat targets
- [ ] Update `src/server/shipit-docs/` for the in-container agent
