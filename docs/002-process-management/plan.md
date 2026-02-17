# Process Management

ShipIt manages three child processes: Claude CLI, Vite dev server, and git. All are injectable via `buildApp(deps)` for testing.

## Dependency Injection

`buildApp()` accepts an `AppDeps` object. Production uses defaults; tests inject stubs.

```typescript
interface AppDeps {
  gitManager?: GitManager;
  createGitManager?: (dir: string) => GitManager;  // Per-session factory
  viteManager?: ViteManager;
  sessionManager?: SessionManager;
  usageManager?: UsageManager;
  authManager?: AuthManager;
  claudeFactory?: () => ClaudeProcess;
  detectPorts?: (excludePorts: number[]) => Promise<number[]>;
  fileWatcher?: FileWatcher;
  workspaceDir?: string;
  serveStatic?: boolean;
  startVite?: boolean;
  portScanIntervalMs?: number;  // 0 to disable in tests
}
```

## ClaudeProcess (`src/server/claude.ts`)

Spawns `claude -p <prompt> --output-format stream-json --verbose` as a child process.

- Parses NDJSON from stdout line-by-line, emits `"event"` for each parsed object
- Emits `"log"` for stderr output and non-JSON stdout lines
- Emits `"auth_required"` when OAuth URL detected in output
- Emits `"done"` with exit code when process ends
- `run(prompt, sessionId?, allowedTools?, systemPrompt?, cwd?)` — spawns the process
- `kill()` — terminates a running process
- Session continuity via `--resume <sessionId>`

## GitManager (`src/server/git.ts`)

Manages git operations per workspace directory.

- `init()` — initializes repo if not exists
- `autoCommit(message)` — stages all, commits (no-op if nothing to commit)
- `log()` — returns commit history
- `rollback(commitHash)` — `git reset --hard <hash>`
- Per-session: `AppDeps.createGitManager` factory creates instances for each session directory

## ViteManager (`src/server/vite-manager.ts`)

Manages the Vite dev server lifecycle. Extends `EventEmitter`.

- `start(workspaceDir?)` — spawns Vite, writes wrapper config with error-capture plugin
- `stop()` — kills the process
- `restart(workspaceDir?)` — stop + start, used on session switch
- Reports `running` / `port` status
- Emits events for status changes

## Test stubs

| Stub | Replaces | Behavior |
|------|----------|----------|
| `FakeClaudeProcess` | `ClaudeProcess` | Records `run()` args, exposes `emit()` for test control |
| `StubViteManager` | `ViteManager` | No-op start/stop, reports `running: false` |
| `StubAuthManager` | `AuthManager` | No-op methods, `checkCredentials()` returns false |
| `StubFileWatcher` | `FileWatcher` | No-op start/stop, `simulateChanges(paths)` for tests |
| `FakeDeployTarget` | `DeployTarget` | Records calls, returns test URL |

All stubs live in `src/server/integration_tests/test-helpers.ts`.

## Key files

- `src/server/index.ts` — `buildApp()` factory, wires all dependencies
- `src/server/claude.ts` — `ClaudeProcess` class
- `src/server/git.ts` — `GitManager` class
- `src/server/vite-manager.ts` — `ViteManager` class
- `src/server/integration_tests/test-helpers.ts` — All test stubs
