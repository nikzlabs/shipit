---
status: in-progress
priority: medium
description: Comprehensive security audit of the ShipIt codebase covering injection, auth, secrets, XSS, Docker hardening, and SSRF with findings and remediation checklist.
---

# 088 — Security Audit (2026-03-28)

Comprehensive security review of the ShipIt codebase covering injection vulnerabilities, authentication, input validation, secrets handling, XSS, SSRF, Docker security, and dependency patterns.

**Overall risk assessment: LOW** — the codebase demonstrates strong defense-in-depth practices.

## Medium Severity

### 1. Path Traversal in `preview.directory`

- **Location**: `src/server/session/preview-config.ts:127-131`
- **Issue**: The `directory` field parsed from `shipit.yaml` is type-checked but not validated to stay within the workspace root. While `path.resolve(workspaceDir, directory)` in `preview-manager.ts` normalizes the path, there is no explicit `startsWith()` guard to reject values like `../../`.
- **Recommendation**: Add an explicit containment check after resolving the path:

```typescript
const resolvedDir = path.resolve(workspaceDir, directory);
if (!resolvedDir.startsWith(workspaceDir + path.sep)) {
  throw new PreviewConfigError("preview.directory must be under the workspace");
}
```

### 2. TOCTOU Race in Docker Bind-Mount Validation

- **Location**: `src/server/orchestrator/docker-proxy-auth.ts:109-125`
- **Issue**: The code validates that bind-mount source paths resolve inside the workspace, but a container process could swap a symlink between validation and the Docker mount syscall. The developers have documented this race condition in code comments.
- **Mitigation in place**: Containers run with `CapDrop: ALL`, limiting blast radius. The race requires precise timing and a pre-existing symlink inside the workspace.
- **Recommendation**: Document this as an accepted risk. Consider enforcing `nosymfollow` mount options or inode-based checks if the threat model changes.

## Low Severity

### 3. Shell Command Execution via `preview.command`

- **Location**: `src/server/session/preview-manager.ts:437`
- **Issue**: The `preview.command` string from `shipit.yaml` is passed to `spawn("sh", ["-c", command])`. This is by design — developers control their own preview configuration.
- **Risk**: Only relevant if `shipit.yaml` is auto-imported from untrusted repositories.
- **Recommendation**: Document that `shipit.yaml` must not be auto-imported from untrusted sources. This is an inherent trust boundary.

### 4. File Operations on User Paths — No Issue Found

- **Location**: `src/server/orchestrator/services/files.ts`
- **Status**: **Secure.** All file read/write operations properly validate paths using `path.resolve()` + `startsWith()` before accessing the filesystem.

## Strengths

The audit identified several well-implemented security controls:

### Input Validation (`src/server/orchestrator/validation.ts`)
- Image size limits: 5 MB per image, 20 MB total
- File size limits: 100 KB per file, 500 KB total
- Base64 decoding verification
- Path traversal checks on all file paths

### Docker Hardening (`src/server/orchestrator/docker-proxy-sanitize.ts`)
- Rejects privileged mode
- Drops `NET_RAW` capability (prevents IP spoofing)
- Rejects host/container network namespace sharing
- Validates all bind-mount paths are under the workspace
- Enforces resource limits (memory, CPU, PIDs)
- Removes dangerous mount options

### Authentication & Authorization
- OAuth flow for Claude CLI (`src/server/orchestrator/auth.ts`)
- GitHub token validation (`src/server/orchestrator/github-auth.ts`)
- Auth checks before spawning agents in WS handlers
- Proper 401/403 responses for unauthenticated requests
- Session-scoped access controls

### Credential Management (`src/server/orchestrator/credential-store.ts`)
- Credentials stored with `0o600` permissions
- Isolated credential volumes per session
- No hardcoded secrets in source code
- Credentials excluded from console output

### SQL Injection Prevention (`src/server/orchestrator/secret-store.ts`)
- All database queries use parameterized statements with `?` placeholders
- No string concatenation in SQL queries

### XSS Prevention
- React's default escaping on all rendered content
- Limited and controlled `dangerouslySetInnerHTML` usage
- Markdown rendered via Marked with sanitization
- Code highlighting via highlight.js (safe)

## Areas Examined

| Area | Files | Result |
|------|-------|--------|
| HTTP routes | `api-routes-*.ts` | Secure |
| WebSocket handlers | `ws-handlers/*.ts` | Secure |
| File uploads/downloads | `services/files.ts`, `validation.ts` | Secure |
| Docker proxy | `docker-proxy-auth.ts`, `docker-proxy-sanitize.ts` | Medium (TOCTOU) |
| Child process spawning | `install-runner.ts`, `preview-manager.ts` | Low (by design) |
| Terminal management | `terminal.ts`, `session-worker.ts` | Secure |
| Agent spawning | `claude.ts`, `codex-adapter.ts` | Secure |
| JSON/data parsing | All routes and handlers | Secure (no eval/Function) |
| Database operations | `secret-store.ts`, `database.ts` | Secure |
| Preview config | `preview-config.ts`, `preview-manager.ts` | Medium (path traversal) |

## Planned proxy policy changes (089-shipit-in-shipit)

[089-shipit-in-shipit](../089-shipit-in-shipit/plan.md) proposes three proxy relaxations to support nested orchestrators. Security analysis:

1. **Allow safe CapAdd when CapDrop: ALL is present** — the allowlist (`CHOWN`, `SETUID`, `SETGID`, `FOWNER`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`, `KILL`) is a strict subset of Docker's default capability set. The dangerous capabilities (`SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, `NET_RAW`) remain blocked. `NET_RAW` is still force-injected into `CapDrop`. **No change to threat model.**

2. **Allow `no-new-privileges` in SecurityOpt** — this is a hardening flag, not a relaxation. Allowing it makes child containers *more* secure. Currently the proxy strips it, which silently weakens child container security. **Improves security posture.**

3. **Volume allowlist for workspace/credentials volumes** — allows sessions to mount the named volumes they were given (by name, not by host path). The session already has full read/write access to these volumes, so allowing child containers to mount them doesn't expand the access boundary. The allowlist is set by the orchestrator, not by the session. **No change to threat model.**

The TOCTOU race (issue #2) applies identically under nested scenarios — same mitigations, same accepted-risk status.

## Checklist

- [x] Audit injection vulnerabilities (command, SQL, template, path traversal)
- [x] Audit authentication and authorization
- [x] Audit input validation on routes and WS handlers
- [x] Audit secrets and credential handling
- [x] Audit XSS vectors
- [x] Audit Docker security controls
- [x] Document findings
- [ ] Fix path traversal in preview.directory (issue #1)
- [ ] Add accepted-risk documentation for TOCTOU race (issue #2)
- [ ] Review proxy policy changes from 089-shipit-in-shipit once implemented
