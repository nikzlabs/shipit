---
status: planned
---

# 058 — Scaffold-based Templates

Replace static file templates with real scaffolding tool invocations where possible, so projects get framework-canonical output (correct `.gitignore`, latest configs, proper directory structure) without us maintaining embedded file strings.

## Problem

Today every template is a `ProjectTemplate` with `files: Record<string, string>` — static strings embedded in `templates.ts`. This means:

- **Stale dependencies** — version ranges (`"react": "^19.0.0"`) drift silently; new major versions require manual updates.
- **Incomplete output** — official scaffolders generate files we skip (e.g. `next-env.d.ts`, `public/` dir, `README.md`, proper lock files after install).
- **Maintenance burden** — every framework update (Vite 7, Next 16, Astro 6) requires hand-editing embedded strings.
- **Missing conventions** — we had no `.gitignore` at all until this was manually added; scaffolders include these by default.

## Design

### Two template modes

Extend `ProjectTemplate` with an optional `scaffold` field. When present, the template is applied by running a command instead of writing static files. When absent, the existing `files` approach is used (backward-compatible).

```typescript
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "fullstack" | "backend" | "utility";
  icon: string;

  // Exactly one of these must be set:
  files?: Record<string, string>;     // Static mode (existing)
  scaffold?: ScaffoldConfig;          // Scaffold mode (new)
}

interface ScaffoldConfig {
  /** Shell command to run inside the session directory.
   *  Executed via `sh -c` with cwd = session workspace.
   *  The command MUST create files in the current directory (`.`),
   *  not in a subdirectory — use scaffolder flags to achieve this. */
  command: string;

  /** Files to write AFTER the scaffold command completes.
   *  Used for shipit.yaml and any overrides (e.g. vite.config.ts host binding). */
  postFiles?: Record<string, string>;
}
```

### Template catalog (proposed)

| Template | Mode | Command | Notes |
|---|---|---|---|
| React + Vite | scaffold | `npm create vite@latest . -- --template react-ts` | Vite scaffolds into `.` with `--template` |
| React + Tailwind + Vite | scaffold | `npm create vite@latest . -- --template react-ts` | postFiles adds Tailwind deps + config |
| Vue + Vite | scaffold | `npm create vite@latest . -- --template vue-ts` | |
| Svelte + Vite | scaffold | `npm create vite@latest . -- --template svelte-ts` | |
| Vanilla + Vite | scaffold | `npm create vite@latest . -- --template vanilla-ts` | |
| Next.js | scaffold | `npx create-next-app@latest . --ts --app --no-tailwind --no-eslint --no-src-dir --no-import-alias --skip-install` | Non-interactive flags |
| Astro | scaffold | `npm create astro@latest . -- --template basics --no-install --no-git` | |
| Static HTML | files | _(keep static)_ | No npm, no scaffolder |
| Express API | files | _(keep static)_ | No official scaffolder worth using |
| Hono API | scaffold | `npm create hono@latest . -- --template nodejs` | |
| Fastify API | files | _(keep static)_ | `fastify-cli generate` is too opinionated |
| Node.js CLI | files | _(keep static)_ | No canonical scaffolder |

### Execution flow

```
1. User selects template in UI
2. POST /api/sessions/:id/template  { templateId: "react-vite-ts" }
3. Orchestrator creates session directory (if needed)
4. applyTemplate() checks template.scaffold vs template.files:

   scaffold mode:
     a. Run scaffold.command via child_process in the session workspace
     b. Write scaffold.postFiles (shipit.yaml, config overrides)
     c. Git commit

   files mode (unchanged):
     a. Write template.files to disk
     b. Git commit

5. install-runner picks up shipit.yaml and runs `npm install`
6. Preview server starts
```

### Post-scaffold overrides

Some scaffolders produce output that needs tweaking for ShipIt's container environment:

- **Vite `server.host`**: Scaffolded `vite.config.ts` doesn't bind to `0.0.0.0`. Override via `postFiles` with a patched config, or append to the generated config.
- **Next.js port/host**: Our `dev` script needs `--port 3001 --hostname 0.0.0.0`. Override via `postFiles["package.json"]` patch, or modify the generated `package.json` after scaffold.
- **shipit.yaml**: Always written via `postFiles` since no scaffolder produces it.

For `package.json` overrides (scripts, ports), a JSON-merge approach is cleaner than full replacement:

```typescript
interface ScaffoldConfig {
  command: string;
  postFiles?: Record<string, string>;
  /** Deep-merge patches applied to generated package.json. */
  packageJsonPatch?: Record<string, unknown>;
}
```

### Key constraints

1. **Scaffolders must support non-interactive mode** — no TTY prompts. Each command above has been verified to work non-interactively.
2. **Scaffolders must support scaffolding into `.` (current dir)** — some default to creating a subdirectory. The `--` separator and `.` argument handle this for npm create.
3. **Network required** — scaffold commands hit the npm registry. This is fine since containers have outbound network access, and `npm install` already requires it.
4. **Timeout** — scaffold commands should complete within 30s (they don't install deps). Add a timeout to the spawn.
5. **Failure fallback** — if the scaffold command fails (network issue, npm registry down), return an error to the client. Don't silently fall back to static files — that would confuse users with different output.

### What we keep static

Templates without a good non-interactive scaffolder stay as `files`:
- **Static HTML** — no npm at all
- **Express API** — `express-generator` is outdated and generates a view-engine app, not an API
- **Fastify API** — `fastify-cli generate` produces an opinionated structure we don't want
- **Node.js CLI** — no canonical scaffolder

These still benefit from the manually curated `.gitignore` and `shipit.yaml`.

### Migration path

1. Add `ScaffoldConfig` type and `scaffold` field to `ProjectTemplate`
2. Update `applyTemplate()` in `templates.ts` to handle scaffold mode
3. Convert templates one at a time (Vite first — covers 5 templates with one command)
4. Verify each conversion produces correct output (add integration tests)
5. Remove static `files` from converted templates

### Testing

- **Unit tests**: Mock `child_process` to verify scaffold commands are called with correct args
- **Integration tests**: Verify that `applyTemplate()` with scaffold mode writes expected files (may need to stub the command or use a lightweight test scaffolder)
- **Manual verification**: Run each scaffold template in a real container and confirm preview works
