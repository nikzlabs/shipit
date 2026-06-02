
# Progressive Testing System

## Problem

Agents run the full test suite (`npm test`, 145+ files, ~80s) on every change, often multiple times per session. The CI then runs the same full suite again on the PR. This wastes time and compute.

## Solution

A three-tier testing strategy:

| Tier | Command | What runs | When |
|------|---------|-----------|------|
| **Dev** | `npm run test:dev` | Affected tests + smoke tests | Agent development (default) |
| **Smoke** | `npm run test:smoke` | ~4 critical-path tests | Quick sanity check |
| **Full** | `npm test` | All 145+ test files | CI on PRs |

### Affected test detection

`scripts/test-dev.ts` finds tests to run by:
1. Getting uncommitted + staged changed files from git
2. For each changed `.ts`/`.tsx` file, checking if a co-located test exists (`foo.ts` → `foo.test.ts`)
3. If shared modules changed (`shared/`, `services/`), including the smoke tests to catch transitive breakage
4. Always including the smoke test set

### Smoke tests

A curated list of ~4 fast tests covering the most critical paths:
- `connection.test.ts` — WebSocket connectivity
- `http-bootstrap.test.ts` — HTTP endpoint wiring
- `git-core.test.ts` — core git operations
- `MessageList.test.tsx` — representative client component

Defined in the `SMOKE_TESTS` array in `scripts/test-dev.ts`.

## Key files

- `scripts/test-dev.ts` — Progressive test runner script
- `package.json` — `test:dev` and `test:smoke` scripts
- `CLAUDE.md` — Agent instructions (use `test:dev` by default)
- `.claude/skills/testing-and-quality/SKILL.md` — Testing skill documentation

## Design decisions

- **Co-located test heuristic over module graph**: We use a simple naming convention (`foo.ts` → `foo.test.ts`) rather than vitest's `--related` flag. This misses some transitive dependencies but is fast, predictable, and the smoke tests catch most transitive breakage. The full suite in CI catches the rest.
- **Two-tier (not one)**: `--changed` alone misses the "always run smoke tests" requirement. A dedicated script gives us control over both affected detection and smoke test inclusion.
- **CI unchanged**: The CI continues running `npm test` (full suite). No changes needed there — it's the safety net.
