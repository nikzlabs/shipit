---
status: in-progress
---

# Agent Platform Documentation

Make ShipIt's platform documentation available to the Claude agent inside session containers, so it understands its runtime environment and can correctly configure projects (e.g., authoring `shipit.yaml`).

## Motivation

Today the agent receives a short system prompt (~75 lines in `agent-instructions.ts`) covering basics: workspace path, auto-git, preview existence, browser tools. But it has no reference material for:

- **`shipit.yaml` configuration** — the agent must guess the schema or rely on the user describing it. If it needs to author a `shipit.yaml` (install command, preview config, resource limits, capabilities), it has no spec to consult.
- **Preview system behavior** — port detection modes, HMR patching, restart triggers, multi-port support. The agent can't troubleshoot preview issues without understanding the system.
- **Deployment** — what targets exist, what prerequisites are needed.
- **GitHub integration** — branch naming, auto-push timing, PR creation flow.
- **Container environment** — installed tools, filesystem layout, dependency cache paths.

The system prompt is the wrong place for all of this — it would burn tokens on every turn for information that's only occasionally needed. Instead, docs should be available on-demand: the agent reads them when relevant.

## Design

### Doc storage and delivery

Platform docs live in `src/server/shipit-docs/` in the repo and are copied to `/shipit-docs/` at the container root during Docker image build:

```dockerfile
COPY src/server/shipit-docs/ /shipit-docs/
```

This is a direct copy to a stable, clean root path — no symlinks, no dependency on the internal app source layout (`/app/src/...`). The path survives image restructuring, rootfs hardening, and layout changes.

`/shipit-docs/` sits alongside other well-known container paths:

| Path | Purpose |
|------|---------|
| `/workspace` | Project root (git repo) |
| `/uploads` | User-uploaded files |
| `/credentials` | OAuth tokens |
| `/dep-cache` | Shared package cache |
| `/shipit-docs` | **Platform reference docs (read-only)** |

### System prompt addition

A short section in `agent-instructions.ts` tells the agent where to find the docs:

```
## ShipIt platform docs

Reference documentation about the ShipIt platform is at /shipit-docs/.
Consult these docs when you need to configure shipit.yaml, troubleshoot
previews, or answer questions about platform capabilities (deployment,
GitHub integration, environment details).
```

This is ~4 lines of system prompt — enough to make the docs discoverable without bloating every turn. The agent uses its Read/Bash tool to access them on demand.

### Doc topics

Six files, each 50–100 lines. Written for the agent (second person, reference tone), not end users.

| File | Content |
|------|---------|
| `README.md` | Index — lists available docs and when to consult each |
| `environment.md` | Container filesystem layout, installed tools, auto-git, hot reload, dependency detection, resource limits |
| `shipit-yaml.md` | Full `shipit.yaml` config reference — `install`, `preview` (command/html modes), `ports`, `directory`, `resources`, `capabilities`. Includes examples. |
| `preview.md` | Preview system internals — port detection (explicit vs auto), multi-port, HMR, restart triggers, browser tool usage, troubleshooting |
| `deployment.md` | Deploy targets (Vercel, Cloudflare), prerequisites, framework detection, how deployment is triggered |
| `github.md` | Branch model, auto-push (5s debounce), PR creation, CI status polling, repo import |

The most important doc is `shipit-yaml.md` — this is the primary thing the agent needs to author correctly. It includes the full schema with types, defaults, max values, and examples for common project setups.

### What these docs are NOT

- **Not duplicates of `docs/NNN-*` feature plans.** Those are internal dev docs describing how features were implemented. These are runtime reference docs describing how the platform behaves.
- **Not user-facing documentation.** The audience is the agent, not the human user. The tone is "here's your environment, here's what you control, here's the config format."
- **Not exhaustive.** They cover what the agent needs to act autonomously. Implementation details (WebSocket protocols, container networking, SSE reconnection) are intentionally omitted.

### Dockerfile changes

Both session worker Dockerfiles need the `COPY` line:

**`Dockerfile.session-worker.dev`** — direct copy after the session/shared code copies:
```dockerfile
COPY src/server/shipit-docs/ /shipit-docs/
```

**`Dockerfile.session-worker.prod`** — same direct copy in the production stage (not from the build stage, since these are static markdown files that don't need compilation):
```dockerfile
COPY src/server/shipit-docs/ /shipit-docs/
```

**`Dockerfile.session-worker.docker`** — inherits from the dev image, no changes needed.

### No volume mounts needed

Since the docs are baked into the image (small, versioned with the code), no bind mounts or volume mounts are needed. `container-lifecycle.ts` and `buildMounts()` are untouched.

## Key files

| File | Change |
|------|--------|
| `src/server/shipit-docs/*.md` | New — 6 platform doc files |
| `src/server/orchestrator/agent-instructions.ts` | Add ~4-line "ShipIt platform docs" section |
| `docker/Dockerfile.session-worker.dev` | Add `COPY src/server/shipit-docs/ /shipit-docs/` |
| `docker/Dockerfile.session-worker.prod` | Add `COPY src/server/shipit-docs/ /shipit-docs/` |

## Considerations

### Token efficiency

The docs are never injected into the system prompt. The agent reads them on demand via its Read tool, paying tokens only when the information is actually needed. The system prompt cost is ~4 lines (the pointer to `/shipit-docs/`).

### Image size

Six markdown files total ~15-20KB. Negligible impact on image size.

### Keeping docs in sync

Docs live in `src/server/shipit-docs/` and are versioned with the code. When a feature changes (e.g., new `shipit.yaml` field), the corresponding doc should be updated in the same PR. This is similar to how `agent-instructions.ts` is maintained today.

### Alternatives considered

**Expand the system prompt** — Burns tokens on every turn for information that's only occasionally needed. Not progressive.

**Mount a volume from the host** — Adds complexity to container lifecycle, mount configuration, and host-side path management. Unnecessary since the docs are small and static.

**MCP tool (`shipit_help`)** — The agent would call a tool to query docs. Heavyweight: requires another MCP server process, latency for every query. A filesystem read is simpler and the agent already knows how to read files.

**Put docs under `src/server/shared/`** — Shared is for code, not prose. A dedicated directory is clearer and easier to copy selectively in Dockerfiles.

**Symlink from `/app/src/server/shipit-docs` to `/shipit-docs`** — Leaks the internal image layout. Breaks if the app source path changes. A direct `COPY` to the root path is decoupled and stable.
