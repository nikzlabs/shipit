---
status: in-progress
---
# 096 — `.claude/skills/` Access: Editor Visibility and Write Permission

## Summary

Two related issues prevent the agent (and the human in the IDE) from working on `.claude/skills/*.md` from inside ShipIt:

1. **The file tree panel hides them.** The workspace scanner at `src/server/shared/file-tree.ts` skips any entry whose name starts with `.` (with a narrow allow-list for `.env` / `.env.local`). `.claude/` is invisible in the UI, even though the files are present on disk and version-controlled.
2. **The Claude Code harness requires explicit user permission to write under `.claude/`** — by default, edits to `.claude/skills/SKILL.md` files trigger a permission prompt and silently abort if no decision is made (or, in some flows, the agent gives up and reports the failure). The project ships no `.claude/settings.json` opting in.

The combined effect: skills can't be browsed, opened, or edited by the agent without manual workarounds. Skills are part of the codebase — they're checked into git, they ship CLAUDE.md-equivalent guidance, they evolve as the architecture evolves. They should be first-class editable artifacts.

## Motivation

When working on the WebSocket-disconnect bug class (feature 094 follow-up), I tried to add a "WebSocket lifecycle MUST NOT affect server behavior" section to `.claude/skills/server-architecture/SKILL.md` — the skill that auto-loads when working on WS handlers. The Edit tool returned:

> Claude requested permissions to write to `/workspace/.claude/skills/server-architecture/SKILL.md`, but you haven't granted it yet.

The CLAUDE.md update worked because CLAUDE.md sits in the project root, outside `.claude/`. But CLAUDE.md isn't the right home for handler-specific guidance — that's exactly what skills are for. The current setup forces guidance into a single file or scatters it across docs that don't auto-load.

Beyond the immediate edit, the broader problem is that **anything inside `.claude/` is invisible to both the agent and the human via the IDE's file tree**. New contributors don't discover the skills. Stale skills don't get pruned. The directory becomes write-once, and that defeats the point.

## Design

### Fix 1 — Show `.claude/` in the file tree

`src/server/shared/file-tree.ts:26-28` currently does:

```ts
if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
// Skip hidden files/dirs (except common ones like .env)
if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".env.local") continue;
```

Add `.claude` to the dotfile allow-list. Result: `.claude/skills/*.md` becomes visible in the workspace pane like any other markdown file. Hidden directories that genuinely should stay hidden (`.git`, `.cache`, `.vite`, `.next`) remain in `WORKSPACE_SKIP_DIRS` and are still excluded by the first check.

```ts
const HIDDEN_ALLOWLIST = new Set([".env", ".env.local", ".claude"]);
// ...
if (entry.name.startsWith(".") && !HIDDEN_ALLOWLIST.has(entry.name)) continue;
```

This is the entire change in this codebase. The same constant could later be reused by the file watcher and markdown scanners if those grow similar filters.

#### Edge cases

- `.claude/projects/`, `.claude/cache/`, `.claude/sessions/` — none of these exist inside the project workspace; they live in `~/.claude/`. The workspace scanner only sees what's in the project, so the only thing this change exposes in practice is `.claude/skills/`.
- Future things in `.claude/` (e.g., `.claude/settings.json`, `.claude/commands/`) become visible too. That's the right behavior — they're project-level configuration the user should be able to inspect.

### Fix 2 — Grant the harness permission to write under `.claude/`

There is no `.claude/settings.json` in the repo today. The Claude Code harness uses a settings file (typically `.claude/settings.json` or `.claude/settings.local.json` per the `update-config` skill description) to declare per-project tool permissions.

Create `.claude/settings.json` with an explicit allow rule for the Edit/Write tools targeting `.claude/skills/**`:

```json
{
  "permissions": {
    "allow": [
      "Edit(.claude/skills/**)",
      "Write(.claude/skills/**)"
    ]
  }
}
```

Scope the permission as narrowly as possible — only `.claude/skills/`, not all of `.claude/` — so settings, secrets, and credentials stored in `~/.claude/` (or anything other than skills) are not implicitly granted.

Whether this file should be `.claude/settings.json` (committed, applies to all collaborators) or `.claude/settings.local.json` (per-developer, gitignored) is a project policy choice. The argument for committing it: skills are a project asset, not a personal preference. Edit access to `.claude/skills/*.md` should be the default for everyone working on this codebase. The argument against: some teams want every developer to opt in explicitly. **Recommendation: commit `.claude/settings.json`. The agent inside ShipIt sessions runs as the project's collaborator, not a personal one.**

The exact JSON schema for the permissions block is harness-controlled and may evolve. The `update-config` skill is the canonical reference; we should consult it before merging if the format here is wrong.

### Fix 3 — Apply the deferred skill edit

While we're here, apply the skill change that was originally blocked. Add a new section to `.claude/skills/server-architecture/SKILL.md` mirroring the rule that landed in `CLAUDE.md`:

> ### Critical rule: WebSocket lifecycle MUST NOT affect server behavior
>
> WS disconnects and reconnects are routine. They MUST NOT stop agents, dispose runners, destroy containers, or corrupt persisted state. ... [full text in `CLAUDE.md` "WebSocket lifecycle MUST NOT affect server behavior"]

This section is critical context for any future work on WS handlers. CLAUDE.md is loaded for every turn; the skill is loaded only for relevant tasks — both should carry the rule, since both audiences (the agent and the human reader) consult them at different times.

The exact text to add is in **Appendix A** below.

## Migration / rollout

1. Apply the file-tree change to `fs-constants.ts` + `file-tree.ts`. Verify `.claude/skills/` shows in the UI's file panel (browser test).
2. Create `.claude/settings.json` with the scoped permission. Restart the agent session if needed.
3. Edit the skill file — should now succeed without the permission prompt.
4. Confirm: lint, typecheck, full test suite.

No data migration. No client changes. The only runtime effect is the file tree showing one more directory.

## Bootstrap problem (observed)

Trying to create `.claude/settings.json` from inside the agent session is itself blocked by the same harness permission system that blocks editing `.claude/skills/`. The harness treats `.claude/` as a privileged directory regardless of which file in it is being touched.

This means **the initial `.claude/settings.json` must be created out-of-band**:
- by the human, in a non-agent terminal, or
- via the harness's own `update-config` skill (which has a different permission scope), or
- by accepting the in-IDE permission prompt the first time the agent attempts the write (the harness's standard escalation flow).

Once the file exists, subsequent edits to it (and to `.claude/skills/**`) succeed automatically. Document this as the bootstrap step in the rollout plan; don't expect a follow-up agent run to create the settings file unaided.

## Risks

- **Settings format wrong.** The harness's settings schema is documented in the `update-config` skill, which we don't have direct access to from here. If the JSON schema differs (e.g., `tools` instead of `permissions`, or different match-pattern syntax), the file is silently ignored. Mitigation: after creating the file, attempt the deferred skill edit; success or failure of that operation is the test.
- **Information leakage.** Showing `.claude/` in the file tree exposes whatever else lives there (settings, command snippets). Today the workspace `.claude/` only contains `skills/`. If credentials or secrets ever land in `.claude/` (they shouldn't — secrets go in the credentials volume), they'd become visible. Mitigation: keep the file tree exposure narrow; if `.claude/` ever holds non-shareable artifacts, switch from "allow `.claude`" to "allow specifically `.claude/skills`".
- **Permissions over-broad.** Granting `Edit(.claude/skills/**)` lets the agent rewrite any skill. That's intended — skills are code-equivalent and evolve with the codebase. But a malicious or hallucinated edit could introduce bad guidance. Mitigation: skills are version-controlled; review skill changes in PRs like any other code.

## Key files

| File | Change |
|---|---|
| `src/server/shared/file-tree.ts` | Add `.claude` to the hidden-dotfile allow-list |
| `src/server/shared/fs-constants.ts` | (Optional) Move the allow-list into a constant alongside `WORKSPACE_SKIP_DIRS` for reuse |
| `.claude/settings.json` | New — scoped Edit/Write permission for `.claude/skills/**` |
| `.claude/skills/server-architecture/SKILL.md` | Add the WebSocket-lifecycle rule (deferred from prior work) |

## Appendix A — Required edit to `server-architecture/SKILL.md`

Inserted immediately after the existing "Handler Files" table:

```markdown
### Critical rule: WebSocket lifecycle MUST NOT affect server behavior

WS disconnects and reconnects are routine. They MUST NOT stop agents, dispose runners, destroy containers, or corrupt persisted state. Concretely:

- **`socket.on("close")` only calls `detachFromRunner()`.** It must NOT call `enforceIdleContainerLimit()`, `runner.dispose()`, `agent.kill()`, `containerManager.destroy()`, or anything that affects state. Idle cleanup runs on a periodic timer with a 60s grace period.
- **`runner.dispose()` refuses to kill running agents** unless `{ force: true }` is passed (shutdown / archive / repo-delete only).
- **Inside async closures (`agent.on("event"|"done"|"error")`, `setTimeout`, `Promise.then`, recursive turns), capture `runner` / `capturedSessionId` / `capturedSessionDir` ONCE at function entry.** Never call `ctx.getX()` or `ctx.setX()` inside those closures — they route through per-connection state and silently no-op after disconnect. Mutate `runner.X` directly and emit via `runner.emitMessage()` (which broadcasts to all viewers AND buffers for reconnects), not `ctx.send()`.
- **Resolve runners via the registry**: `ctx.getRunnerRegistry().get(capturedSessionId) ?? ctx.getRunner()`. The registry survives WS disconnects; `attachedRunner` doesn't.
- The ctx setters in `index.ts` throw under `VITEST` and warn in production when called with no resolvable runner. If you trip that, you've introduced this bug class — fix it by capturing the runner upfront.
```
