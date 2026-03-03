---
description: "ShipIt testing conventions and quality checklist: Vitest config (server vs client), server test patterns (temp dirs), integration tests (buildApp, TestClient, test-helpers.ts), client tests (render, renderHook, FakeWebSocket), mocking patterns, and the pre-completion quality checklist (input validation, component tests, integration tests). Load when writing tests, reviewing coverage, or completing a feature."
user-invocable: true
---

# Testing Conventions & Quality Checklist

## Progressive Testing

During development, use `npm run test:dev` instead of `npm test`. This runs:
1. **Affected tests** — tests co-located with files you've changed (uncommitted + staged)
2. **Smoke tests** — a small set of critical-path tests that always run

The full suite (`npm test`) runs in CI on every PR. Only run it locally if you suspect wide-reaching breakage.

| Command | When to use |
|---------|-------------|
| `npm run test:dev` | Default for development — fast, targeted |
| `npm run test:dev -- --list` | Dry run — see which files would run |
| `npm run test:smoke` | Smoke tests only |
| `npm test` | Full suite — CI runs this, rarely needed locally |
| `npx vitest run path/to/file.test.ts` | Run a single specific test file |

Smoke tests are defined in `scripts/test-dev.ts` (the `SMOKE_TESTS` array). Keep the list small (~4-6 files).

## Test Configuration

Tests use Vitest with two project configs in `vitest.config.ts`:
- **Server tests** (`src/server/**/*.test.ts`) — Node environment
- **Client tests** (`src/client/**/*.test.{ts,tsx}`) — jsdom environment with React Testing Library

## Server Tests

- Use temp directories (`fs.mkdtempSync`) cleaned up in `afterEach` with `fs.rmSync(tmpDir, { recursive: true, force: true })`.
- Testability is built in — modules accept optional constructor parameters for isolation: `SessionManager(sessionsFile?)`, `GitManager(workspaceDir?)`, `UsageManager(usageFile?)`, `ThreadManager(threadsDir?)`, `DeploymentStore(baseDir?)`.

## Integration Tests

Live in `src/server/orchestrator/integration_tests/` — one file per feature area.

Shared stubs and helpers (`TestClient`, `StubViteManager`, `StubAuthManager`, `FakeClaudeProcess`, `StubFileWatcher`, `waitForClaude`) are in `test-helpers.ts`.

Each test file:
1. Uses `buildApp()` with injected stubs
2. Listens on port 0 (ephemeral)
3. Connects via the `TestClient` message-buffering WebSocket wrapper

When adding a new integration test, create a new file in this directory (or add to an existing one if the feature area matches) and import helpers from `./test-helpers.js`.

### HTTP endpoint tests

Use `app.inject()`:
```typescript
const res = await app.inject({
  method: "GET",
  url: `/api/sessions/${sessionId}/files`,
});
expect(res.statusCode).toBe(200);
```

### WebSocket message tests

Use `TestClient`:
```typescript
const client = new TestClient(wsUrl);
await client.connected;
client.send({ type: "send_message", text: "hello", sessionId });
const msg = await client.waitFor("agent_event");
```

## Client Tests

### Component tests

Use `render()` from `@testing-library/react` with `cleanup` in `afterEach`.

```typescript
import { render, screen, cleanup } from "@testing-library/react";
afterEach(cleanup);

it("renders the component", () => {
  render(<MyComponent />);
  expect(screen.getByText("Hello")).toBeInTheDocument();
});
```

### Hook tests

Use `renderHook()` with `FakeWebSocket` (stubbed via `vi.stubGlobal`) and `vi.useFakeTimers()`.

## Mocking Patterns

- `vi.mock()` for module mocks
- `vi.fn()` for function spies
- Manual stub/fake classes for complex dependencies
- ESLint allows `any` in test files

## Assertion Patterns

- `toMatchObject()` for partial WS message matching
- `toEqual()` for exact structure
- `@testing-library/jest-dom` matchers for DOM assertions

## Quality Checklist (run before marking a task done)

Every new feature must satisfy these before it's considered complete:

1. **Input validation at system boundaries** — WebSocket handlers must validate user-supplied strings (empty, whitespace-only, too long) and return `{ type: "error" }`. Never trust client input.

2. **Component tests for new UI** — every new React component (or significant UI addition to an existing component) needs a `*.test.tsx` file with `@testing-library/react`. Cover the happy path, edge cases (empty input, escape/cancel), and callback wiring.

3. **Blur/focus edge cases** — inline editors that save on blur must handle the case where blur is triggered by a parent element (e.g. backdrop dismiss) that *cancels* the edit. Use a ref guard to prevent double-fire.

4. **Integration tests for new endpoints** — every new HTTP endpoint or WS message type needs at least one happy-path and one error-path integration test in `src/server/orchestrator/integration_tests/`. HTTP tests use `app.inject()`. WS tests use the `TestClient` helper. Add to an existing file if the feature area matches, or create a new `<feature>.test.ts` file and import shared helpers from `./test-helpers.js`.

5. **Split slow test files** — if a single test file takes more than ~10 seconds to run, split it into smaller files by feature area so Vitest can parallelize them.
