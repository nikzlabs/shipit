# CLAUDE.md

## Setup

```bash
npm install
```

## Development commands

- `npm test` — run all tests (vitest, requires `npm install` first)
- `npm run lint` — run ESLint on `src/`
- `npm run typecheck` — run TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — start dev server
- `npm run build:client` — build client with Vite

## Testing

Tests use Vitest with two project configurations (defined in `vitest.config.ts`):

- **server** tests (`src/server/**/*.test.ts`) — run in Node environment
- **client** tests (`src/client/**/*.test.{ts,tsx}`) — run in jsdom environment with React Testing Library

Run a single test file:

```bash
npx vitest run src/server/git.test.ts
```

## Project structure

- `src/server/` — Fastify backend with WebSocket support
- `src/client/` — React frontend (Vite + Tailwind)

## Tech stack

- TypeScript (ESM — `"type": "module"` in package.json)
- Fastify (server)
- React 19 (client)
- Vitest (testing)
- Vite (bundler)
- Tailwind CSS v4
