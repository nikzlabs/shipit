---
status: in-progress
priority: medium
description: Comprehensive security audit of the ShipIt codebase covering injection, auth, secrets, XSS, Docker hardening, and SSRF with findings and remediation checklist.
---

# 088 — Security Audit (2026-03-28)

Comprehensive security review of the ShipIt codebase covering injection vulnerabilities, authentication, input validation, secrets handling, XSS, SSRF, Docker security, and dependency patterns.

**Overall risk assessment: LOW** — the codebase demonstrates strong defense-in-depth practices.

> **2026-05-20 addendum** — Re-reviewed against Anthropic's [managed-agents architecture](https://www.anthropic.com/engineering/managed-agents). That writeup's central thesis (*"the tokens are never reachable from the sandbox where Claude's generated code runs"*) applies directly to ShipIt, because **ShipIt runs the agent CLI *inside* the per-session container** — the sandbox and the code-execution environment are the same box. The review confirmed ShipIt already implements the article's proxy-auth pattern for GitHub mutations (the `gh` shim) and strong per-session / per-agent credential isolation, but it also surfaced two prompt-injection / exfiltration exposures not captured in the original audit (findings #5 and #6 below). The "LOW" headline predates the managed-agents threat model; treat findings #5/#6 as the open items that gate it.

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

## Managed-agents architecture review (2026-05-20)

This section evaluates ShipIt against the security principles in Anthropic's *"How we built our managed agents"* engineering post. The post's premise is that the original coupled design was dangerous because *"any untrusted code that Claude generated was run in the same container as credentials — so a prompt injection only had to convince Claude to read its own environment."* The fix was structural: keep credentials physically out of the sandbox and broker privileged operations through a proxy.

ShipIt's architecture is the coupled shape the article warns about — **the agent CLI executes inside the same container that the agent's tool calls (`Bash`, file writes, spawned processes) run in.** So the question for every credential is: *is it reachable from inside that container?* A prompt-injected agent (e.g. a malicious instruction embedded in a fetched web page, a dependency's README, or repo content) can run arbitrary shell, so any credential on disk or in env inside the container is exfiltratable — especially given there is **no network egress restriction** (finding #6).

### What ShipIt already does right (matches the article)

- **Proxy-auth for GitHub mutations — the `gh` shim.** `src/server/session/agent-shim/gh.ts` replaces the real GitHub CLI with a narrow shim that POSTs to the worker's `/agent-ops/*` router on localhost; the orchestrator's `GitHubAuthManager` performs the actual API call using the token. This is exactly the article's *"the harness is never made aware of any credentials"* proxy pattern, and it deliberately drops the large mutation surface (`gh api`, `gh repo`, `gh workflow`) the real CLI would expose.
- **Per-session and per-agent credential isolation.** `session-credentials.ts` mounts only `<credentialsRoot>/sessions/<sessionId>` at `/credentials`, and copies in only the *pinned* agent's subtree (a Claude session never has `.codex` on disk, and vice-versa). This limits blast radius the way the article's per-session scoping does.
- **Durable, transport-independent event log.** The turn-event log + `runner.emitMessage()` buffering and `ChatHistoryManager` persistence mirror the article's *"durable record of events… nothing in the harness needs to survive a crash."* WebSocket lifecycle is explicitly forbidden from driving server state (see CLAUDE.md), keeping the privileged orchestrator effectively stateless w.r.t. the transport.
- **Orchestrator-level credentials stay out of the container.** The user's GitHub *operations* token (for API calls), the orchestrator's own Claude/Anthropic credentials used for platform features, and PR/CI fetching all execute orchestrator-side. The agent only ever receives *resolved values* it's explicitly granted.

### New findings surfaced by this lens

## High Severity

### 5. GitHub PAT is reachable from inside the sandbox via `/credentials/.gitconfig`

- **Location**: `src/server/orchestrator/git-config.ts:94-99` (helper construction) + `src/server/orchestrator/session-credentials.ts:51,90-124` (mount).
- **Issue**: `setGlobalCredentialHelper()` writes the **raw token inline** into the global git config as a shell one-liner:

  ```
  credential.helper = !f() { echo "password=${token}"; echo "username=x-access-token"; }; f
  ```

  That `.gitconfig` is in `SHARED_CREDENTIAL_PATHS` and is copied into every session's `/credentials` subtree, which is mounted into the container with `GIT_CONFIG_GLOBAL=/credentials/.gitconfig`. So a prompt-injected agent can read the token directly:

  ```sh
  cat /credentials/.gitconfig                       # token is in plaintext
  git config --global --get credential.helper       # ditto
  printf 'protocol=https\nhost=github.com\n\n' | git credential fill   # prints it
  ```

- **Why it matters**: This is precisely the failure the article calls out — *"a prompt injection only had to convince Claude to read its own environment."* The `gh` shim closes the *API-surface* hole but not this one: the underlying PAT is still physically present in the sandbox. With no egress controls (finding #6), exfiltration is a one-liner. The article's stated goal is that *"git push and pull work from inside the sandbox without the agent ever handling the token itself"* — ShipIt does not yet meet that bar for raw git transport.
- **Recommendation**: Replace the inline-token helper *in the container's* gitconfig with a **brokering credential helper** that mirrors the `gh` shim: a small `shipit-git-credential` binary installed in the session image, configured as `credential.helper = shipit-git-credential`, that POSTs to the worker (`/agent-ops/git/credential`) and returns the token only to git's credential protocol over localhost — never landing it on disk or in env. The orchestrator keeps the real token. (The orchestrator-side gitconfig can keep the inline helper, since the orchestrator is the trust boundary, not the sandbox.) If a brokered helper is too invasive short-term, at minimum stop copying the token-bearing `.gitconfig` into the container and inject identity-only config, routing all pushes through an orchestrator-side git proxy.

## Medium Severity

### 6. No network egress controls on agent containers

- **Location**: `src/server/orchestrator/container-lifecycle.ts` (HostConfig) — containers attach to the session bridge network (`shipit-session-<id>`) or the orchestrator bridge with **default outbound internet access**. `docker-proxy-sanitize.ts:43-46` blocks host/container *namespace sharing* but does not restrict egress.
- **Issue**: Several credentials *must* live inside the container by design (the article accepts this for the agent's own auth): the pinned agent's CLI OAuth (`/credentials/.claude` or `.codex`), MCP secrets and MCP OAuth access tokens injected as `mcp__*` / `MCP_PLATFORM_*` env, and user secrets marked `agent: true` written to `.shipit/.env.agent`. Combined with unrestricted egress, a single prompt injection can POST all of these (plus the GitHub PAT from finding #5) to an attacker-controlled host. There is no allowlist, no proxy chokepoint, and no detection.
- **Why it matters**: This is the other half of the article's threat model. Credential isolation reduces *what's reachable*; egress control reduces *what a compromise can do with it*. ShipIt currently has neither for the in-container credential set.
- **Recommendation**: Introduce an egress policy for agent containers. Options, roughly in order of effort/strength:
  1. Route container HTTP(S) through an orchestrator-managed forward proxy with an allowlist (GitHub, the configured Anthropic/agent endpoints, the configured MCP server hosts). This also gives a natural place to attach the brokered git credential from finding #5.
  2. A Docker network with no default route + explicit per-session firewall rules to required hosts.
  3. At minimum, document the lack of egress filtering as an accepted risk and ensure secrets marked `agent: true` are opt-in and clearly labeled as exfiltratable to anyone who can inject the agent.
- **Residual / accepted risk**: The agent's own CLI OAuth token is intentionally in the sandbox (the CLI needs it to function), matching the article's acceptance of the agent's own credentials being present. The mitigations above shrink the exfiltration window for *all* in-container credentials rather than trying to remove them.

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
| Credential reachability from sandbox | `git-config.ts`, `session-credentials.ts`, `agent-shim/gh.ts` | High (GitHub PAT readable in-container — #5) |
| Container network egress | `container-lifecycle.ts`, `docker-proxy-sanitize.ts` | Medium (no egress controls — #6) |

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
- [x] Review architecture against Anthropic managed-agents threat model (credential reachability + egress)
- [ ] Fix path traversal in preview.directory (issue #1)
- [ ] Add accepted-risk documentation for TOCTOU race (issue #2)
- [ ] Review proxy policy changes from 089-shipit-in-shipit once implemented
- [ ] **Fix GitHub PAT reachability from sandbox (issue #5)** — replace in-container inline-token credential helper with a brokering helper (`shipit-git-credential`) that proxies to the worker, mirroring the `gh` shim; stop copying the token-bearing `.gitconfig` into the container
- [ ] **Add egress controls for agent containers (issue #6)** — orchestrator forward proxy with host allowlist (GitHub + Anthropic/agent endpoints + configured MCP hosts), or document as accepted risk with `agent: true` secrets clearly labeled exfiltratable
