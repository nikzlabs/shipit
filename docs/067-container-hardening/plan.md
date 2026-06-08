---
description: Remaining security hardening deferred from containerization: non-root worker runtime, network egress allowlist, read-only credential mounts, and cross-platform validation.
---

# 067 — Container Hardening & Cross-Platform Validation

Remaining work from 051 (Docker-Per-Session Containerization) that was deferred to post-launch.

## Cross-Platform Validation

macOS (Docker Desktop, Apple Silicon, virtiofs) is fully validated. Linux and WSL2 remain.

### Docker socket auto-detection

- [ ] Linux (Docker Engine) — verify `docker.ping()` via `/var/run/docker.sock`
- [ ] Windows WSL2 (Docker Desktop WSL2 backend)
- [ ] Windows WSL2 (Docker Engine installed inside WSL2)

### Bind mount path validation

- [ ] Linux: `/workspace/sessions/{uuid}` → container `/workspace`
- [ ] WSL2: WSL2 filesystem paths (`/home/user/...`) mount correctly

### Performance baseline

- [ ] Linux: document cold start time, `npm install` duration, file I/O throughput
- [ ] WSL2: verify workspace on WSL2 filesystem (not `/mnt/c/`) for acceptable performance

### Setup documentation

- [ ] Add setup documentation for each platform (Docker installation prerequisites)

## Security Hardening

### Credential mounts

- [ ] Switch `/credentials` to read-only once Claude CLI `--resume` write path is isolated

### Non-root worker

- [ ] Run the session worker runtime as a non-root user. Detailed design:
  `docs/150-non-root-session-worker/plan.md`.

This is now split into its own feature doc because it touches Dockerfiles,
runtime environment, Claude/Codex auth paths, terminal spawning, install hooks,
MCP config, cache ownership, and capability tightening. Doc 067 remains the
umbrella hardening tracker.

### Network egress restriction

- [ ] Allowlist `api.anthropic.com`, `github.com`, `registry.npmjs.org`

### `--dangerously-skip-permissions` support

- [ ] Add `skipPermissions` flag to `ContainerConfig` (gated on `useContainers: true`)
- [ ] Pass `SKIP_PERMISSIONS` env var to container
- [ ] Session worker reads env var and adds `--dangerously-skip-permissions` to Claude CLI args
- [ ] **Prerequisite:** credential read-only mount + network egress allowlist must be done first
- [ ] Default to opt-in initially, flip to default-on after egress restrictions are validated

## Git Improvements

### In-container git operations

- [ ] `GIT_OBJECT_DIRECTORY` optimization — allow in-container commits for worktree sessions (skip orchestrator round-trip)

## Housekeeping

- [ ] Update doc 048 status to superseded by 051 session-ID routing
