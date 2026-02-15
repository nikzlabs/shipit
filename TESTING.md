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
│   └── markdown.ts          →  markdown.test.ts
└── client/
    └── hooks/
        └── useSearch.ts     →  useSearch.test.ts
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

### Client Tests

| Module | Tests | What's covered |
|--------|-------|----------------|
| `useSearch` | 16 | Matching, case-insensitivity, navigation cycling, clear |

## Writing New Tests

1. Create a `*.test.ts` file next to the module
2. Server tests run in Node — use real file I/O with `os.tmpdir()` for isolation
3. Client tests run in jsdom — use `renderHook` from `@testing-library/react`
4. For modules that spawn processes, mock `node:child_process` with `vi.mock()`

### Testability Patterns

Several modules accept optional constructor parameters for test isolation:

- `SessionManager(sessionsFile?)` — override the JSON file path
- `GitManager(workspaceDir?)` — override the workspace directory
- `extractAuthUrl(text)` — exported pure function for URL pattern testing

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
