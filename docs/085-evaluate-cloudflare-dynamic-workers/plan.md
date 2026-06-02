
# Evaluate Cloudflare Dynamic Workers for ShipIt

## Summary

Cloudflare announced **Dynamic Worker Loader** (open beta, March 2026) — an API that lets a Worker spawn child Workers at runtime with arbitrary code, each in its own V8 isolate sandbox. Blog post: [Sandboxing AI agents, 100x faster](https://blog.cloudflare.com/dynamic-workers/).

## Key capabilities

- **~ms cold starts**, a few MB memory (100x faster, 10-100x more efficient than containers)
- **Network isolation** — `fetch()`/`connect()` blocked by default; controllable per-isolate
- **No filesystem** — pure V8 sandbox, no env vars to leak
- **Isolate caching** — same ID reuses a warm isolate; new ID spins up fresh
- **Global edge** — runs wherever the request lands, no cross-region hops
- **Bundling** — `@cloudflare/worker-bundler` resolves npm deps and bundles with esbuild
- **Code Mode** — `@cloudflare/codemode` converts tools into typed TypeScript APIs for LLMs
- **Virtual FS** — `@cloudflare/shell` provides file manipulation primitives backed by SQLite + R2
- **Constraint**: JavaScript/TypeScript only (Python/WASM possible but slower)

## Relevance assessment

### Not a fit: replacing session containers

ShipIt sessions need full OS capabilities — filesystem, process spawning (Claude CLI, git, dev servers), PTY/terminal, package managers. V8 isolates provide none of these. Dynamic Workers cannot replace Docker containers for session execution.

### Not a fit: existing Cloudflare Pages deploy target

ShipIt already deploys static sites to Cloudflare Pages via `wrangler pages deploy`. Dynamic Workers solve a different problem (runtime code execution, not static hosting).

### Possible fit: Code Mode for tool call optimization

The `@cloudflare/codemode` pattern — LLM writes code against a typed API instead of making sequential tool calls — reduces token usage by up to 81%. ShipIt currently uses Claude Code CLI which handles tool orchestration natively, so this is redundant for the primary agent. Could be relevant if ShipIt ever runs lighter secondary agents (e.g., for automated CI fixes or code review).

### Possible fit: serverless function deploy target

If ShipIt adds a feature where users deploy backend logic (API routes, webhooks, scheduled tasks), Dynamic Workers could be a compelling execution target — instant spin-up, edge-distributed, secure by default. This would be a new deploy target type distinct from the existing Pages target.

### Worth watching: Cloudflare Containers

[Cloudflare Containers](https://blog.cloudflare.com/cloudflare-containers-coming-2025/) (announced for 2025) could be far more relevant — potentially replacing self-managed Docker with Cloudflare-managed containers at the edge. This would address ShipIt's actual needs (full OS, filesystem, processes) with managed scaling and global distribution.

## Recommendation

**No immediate action.** The technology is impressive but targets a different abstraction layer than what ShipIt needs. The interesting libraries to revisit if scope changes:

| Library | Use case |
|---------|----------|
| `@cloudflare/codemode` | Lightweight agent tool execution |
| `@cloudflare/shell` | Virtual filesystem for isolated code |
| `@cloudflare/worker-bundler` | Runtime npm bundling |

**Priority watch**: Cloudflare Containers — a much better fit for ShipIt's session container model.
