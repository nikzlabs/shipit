# Testing

## Quick Start

```bash
npm test          # Run all tests once
npm run test:watch # Run tests in watch mode (re-runs on file changes)
```

## Stack

| Tool | Purpose |
|------|---------|
| [Vitest](https://vitest.dev/) | Test runner (v4, uses Vite's transform pipeline) |
| [@testing-library/react](https://testing-library.com/react) | React hook/component testing |
| [jsdom](https://github.com/jsdom/jsdom) | Browser environment for client tests |

## Project Structure

Tests live alongside source files using the `*.test.ts` / `*.test.tsx` convention:

```
src/
├── server/
│   ├── sessions.ts          →  sessions.test.ts
│   ├── claude.ts            →  claude.test.ts
│   ├── git.ts               →  git.test.ts
│   ├── auth.ts              →  auth.test.ts
│   ├── markdown.ts          →  markdown.test.ts
│   └── index.ts             →  integration.test.ts   (WebSocket E2E)
└── client/
    ├── hooks/
    │   └── useSearch.ts     →  useSearch.test.ts
    └── components/
        ├── MessageList.tsx      →  MessageList.test.tsx
        ├── DiffBlock.tsx        →  DiffBlock.test.tsx
        ├── GitHistory.tsx       →  GitHistory.test.tsx
        ├── ErrorBoundary.tsx    →  ErrorBoundary.test.tsx
        └── ConnectionBanner.tsx →  ConnectionBanner.test.tsx
```

## Test Projects

Vitest is configured with two test projects in `vitest.config.ts`:

- **`server`** — runs in Node environment, covers backend modules
- **`client`** — runs in jsdom environment with React support, covers hooks and components

## What's Tested

### Server Tests

| Module | Tests | What's covered |
|--------|-------|----------------|
| `SessionManager` | 11 | CRUD operations, persistence, sorting, corruption recovery |
| `ClaudeProcess` | 14 | NDJSON parsing, line buffering, auth detection, spawn args, kill |
| `GitManager` | 12 | Init, auto-commit, log, rollback, empty-commit handling |
| `AuthManager` | 11 | URL pattern matching, `extractAuthUrl` extraction and cleanup |
| `findMarkdownFiles` | 7 | Recursive scan, directory skipping, sorting |
| Integration (E2E) | 19 | Full WebSocket flow: connect, sessions, git, docs, Claude lifecycle, multi-client, path traversal, disconnect cleanup |

### Client Tests

| Module | Tests | What's covered |
|--------|-------|----------------|
| `useSearch` | 16 | Matching, case-insensitivity, navigation cycling, clear |
| `MessageList` | 20 | Empty state, user/assistant messages, tool rendering (Edit/Write/Bash/Read/Grep), thinking indicator, activity labels, search highlights, error message styling |
| `DiffBlock` | 12 | File header, edit/write labels, removed/added lines, multi-line diffs, separator, write mode, empty fallback |
| `GitHistory` | 14 | Collapsed/expanded toggle, onRefresh, commit display (abbreviated hash, relative dates), rollback confirmation, blur reset |
| `ErrorBoundary` | 7 | Render children, catch errors, fallback UI, reload button, recover button, error message display |
| `ConnectionBanner` | 6 | Hidden when open, reconnecting message, connection lost message, role=alert, color variants |

## Writing New Tests

1. Create a `*.test.ts` (or `*.test.tsx` for components) file next to the module
2. Server tests run in Node — use real file I/O with `os.tmpdir()` for isolation
3. Client tests run in jsdom — use `renderHook` for hooks, `render` for components
4. For modules that spawn processes, mock `node:child_process` with `vi.mock()`
5. **Always** call `cleanup` from `@testing-library/react` in `afterEach` — automatic cleanup does not work reliably with the current Vitest project config

### Testability Patterns

Several modules accept optional constructor parameters for test isolation:

- `SessionManager(sessionsFile?)` — override the JSON file path
- `GitManager(workspaceDir?)` — override the workspace directory
- `extractAuthUrl(text)` — exported pure function for URL pattern testing
- `buildApp(deps?)` — exported factory that accepts injected dependencies (see [Integration Tests](#integration-tests))

### jsdom Limitations

jsdom doesn't implement all browser APIs. Common workarounds needed:

- **`scrollIntoView`** — not implemented; stub it in `beforeAll`:
  ```ts
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });
  ```
- **`localStorage`** — works in jsdom, but consider clearing in `afterEach` if your component persists state
- **CSS animations** — not rendered; test class names rather than visual effects

### Example: Testing a React Component

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MyComponent } from "./MyComponent.js";

afterEach(cleanup);

describe("MyComponent", () => {
  it("renders text", () => {
    render(<MyComponent label="hello" />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
```

### Example: Testing a Server Module

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("MyModule", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does something", () => {
    // test using tmpDir for file isolation
  });
});
```

## Integration Tests

Integration tests (`src/server/integration.test.ts`) verify the full WebSocket message flow from client to server. They start a real Fastify server with mocked external dependencies and connect real `ws` clients.

### Architecture: `buildApp()` + Dependency Injection

The server entry point (`src/server/index.ts`) exports a `buildApp(deps?)` factory function that creates and configures the Fastify app without starting it. All external dependencies can be injected via the `AppDeps` interface:

```ts
interface AppDeps {
  gitManager?: GitManager;       // Git operations (default: real repo at /workspace)
  viteManager?: ViteManager;     // Vite dev server (default: real process)
  sessionManager?: SessionManager; // Session persistence (default: /workspace/.vibe-sessions.json)
  authManager?: AuthManager;     // OAuth flow (default: real CLI)
  claudeFactory?: () => ClaudeProcess; // How to create Claude processes
  workspaceDir?: string;         // Directory for docs (default: /workspace)
  serveStatic?: boolean;         // Serve dist/client files (default: true)
  startVite?: boolean;           // Auto-start Vite dev server (default: true)
}
```

Production uses defaults; tests inject stubs to avoid spawning child processes.

### Test Setup Pattern

Each test spins up an isolated Fastify server on an ephemeral port:

```ts
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-integration-"));
  gitManager = new GitManager(tmpDir);
  await gitManager.init();

  app = await buildApp({
    gitManager,
    sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
    viteManager: new StubViteManager() as unknown as ViteManager,
    authManager: new StubAuthManager() as unknown as AuthManager,
    claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
    workspaceDir: tmpDir,
    serveStatic: false,
    startVite: false,
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  port = Number(address.match(/:(\d+)$/)?.[1]);
});

afterEach(async () => {
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

### TestClient — Message-Buffering WebSocket Wrapper

The `TestClient` class solves a race condition: the server sends `preview_status` immediately on connection, before the test can set up a listener. `TestClient` attaches a message handler at construction time and buffers incoming messages in a queue:

```ts
const client = await TestClient.connect(port);
const msg = await client.receive();   // Returns buffered or next message
client.send({ type: "list_sessions" });
const resp = await client.receive();
client.close();
```

Key methods:
- `receive(timeoutMs?)` — returns from buffer or waits (rejects after timeout)
- `receiveN(count)` — collect exactly N messages
- `send(msg)` — send typed `WsClientMessage`
- `sendRaw(data)` — send raw string (for invalid-JSON tests)

### Stub Classes

Three stubs replace external dependencies:

| Stub | Replaces | Behavior |
|------|----------|----------|
| `StubViteManager` | `ViteManager` | No-op start/stop, reports `running: false` |
| `StubAuthManager` | `AuthManager` | No-op methods, `checkCredentials()` returns false |
| `FakeClaudeProcess` | `ClaudeProcess` | Records `run()` args, exposes `emit()` for test control |

The `FakeClaudeProcess` is controlled by the test — you call `lastClaude.emit("event", ...)` or `lastClaude.emit("done", 0)` to simulate the CLI producing events.

### What's Covered

| Area | Tests |
|------|-------|
| Connection | `preview_status` on connect |
| Error handling | Invalid JSON, path traversal, non-existent docs |
| Sessions | list, new, delete |
| Git | log, rollback (verifies file system state) |
| Docs | list markdown files, get content |
| Claude flow | `send_message` → events relayed, session tracking, auto-commit on done |
| Claude errors | Error event relay, auth detection |
| Process lifecycle | Kill previous process on new message, kill on disconnect |
| Multi-client | Each client gets own `preview_status` |
| Session tracking | `result` event updates `lastUsedAt` |
