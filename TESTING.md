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
    ├── hooks/
    │   └── useSearch.ts     →  useSearch.test.ts
    └── components/
        ├── MessageList.tsx  →  MessageList.test.tsx
        ├── DiffBlock.tsx    →  DiffBlock.test.tsx
        └── GitHistory.tsx   →  GitHistory.test.tsx
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
| `MessageList` | 17 | Empty state, user/assistant messages, tool rendering (Edit/Write/Bash/Read/Grep), thinking indicator, activity labels, search highlights |
| `DiffBlock` | 12 | File header, edit/write labels, removed/added lines, multi-line diffs, separator, write mode, empty fallback |
| `GitHistory` | 14 | Collapsed/expanded toggle, onRefresh, commit display (abbreviated hash, relative dates), rollback confirmation, blur reset |

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
