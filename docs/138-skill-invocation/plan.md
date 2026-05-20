---
status: planned
priority: medium
---

# 138 — Explicit Skill Invocation (`/my-skill`)

## Summary

The Claude CLI resolves **skills** through the slash-command surface:
`/my-skill` invokes a skill, and — confirmed from `claude --help` — *"Skills
still resolve via `/skill-name`"* even in non-interactive `-p`/print mode
(`--disable-slash-commands` is documented literally as "Disable all skills").

So skill invocation is the one slash-command bucket that does **not** need a
ShipIt-native reimplementation — the prompt just has to reach the CLI with the
`/skill-name` token at position 0. This doc carves that capability out of
doc 132 (where it was "Bucket 3 — bundled skills, pass through") into a
focused, ship-on-its-own slice, because doc 132's claim that these "already
work via `-p`" is only half true: two concrete blockers in the current code
stop `/my-skill` from working today.

This covers **invocation** of skills. Doc 096 (`claude-skills-access`,
status: done) already handles *authoring/editing* skills (`.claude/skills/**`
is writable by session agents).

## What's actually broken today

### Blocker 1 — the prompt loses its leading `/`

In `agent-execution.ts` (the `runAgentWithMessage` prompt assembly), attached
**file context** and **image context** are *prepended* to the user text:

```ts
let prompt = userText;
if (validatedFiles.length > 0) {
  prompt = `${formatFileContext(validatedFiles)}\n\n${prompt}`;
}
if (images?.length && activeDir) {
  prompt = `${saveImagesToUploadsDir(images, activeDir)}\n\n${prompt}`;
}
```

The CLI only resolves `/skill-name` when the token sits at the very start of
the prompt. A bare `/my-skill` message works, but the moment the user attaches
a file or image the prompt becomes `[file context]\n\n/my-skill` and the
slash command is silently swallowed as literal prose.

### Blocker 2 — the `Skill` tool isn't allowlisted

`claude.ts` defines `AUTO_TOOLS` / `PLAN_TOOLS` / `NORMAL_TOOLS`; none include
`Skill` (no `Skill`/`skill` reference anywhere in `src/server/session`). In
headless `-p` mode a tool absent from `--allowedTools` is denied — there is no
human to approve the prompt. A skill that drives tool use, or a model-initiated
`Skill` call, is blocked.

## Design

### 1. Preserve the leading slash when building the prompt

In `agent-execution.ts`, detect a slash-command/skill invocation and append
context *after* the command instead of prepending, so the CLI still sees
`/my-skill …` at index 0:

```ts
const isSlashInvocation = /^\/[a-zA-Z0-9._-]+/.test(userText.trimStart());
prompt = isSlashInvocation
  ? [userText, fileContext, imageContext].filter(Boolean).join("\n\n")
  : [imageContext, fileContext, userText].filter(Boolean).join("\n\n");
```

One ordering decision, applied uniformly to both file and image context.

### 2. Add `Skill` to the tool allowlists

Add `Skill` to `AUTO_TOOLS` and `NORMAL_TOOLS` in `claude.ts`. Leave it out of
`PLAN_TOOLS` — skills can be side-effecting, and plan mode is deliberately
read-only (same rationale that omits user MCP globs from `PLAN_TOOLS`).

These two changes are the **functional core**: together they make `/my-skill`
work for any user who already knows the skill name, with or without
attachments. They are low-risk and shippable on their own.

### 3. Composer `/` autocomplete (discoverability)

Mirror the existing `@` file-autocomplete in `MessageInput.tsx` /
`FileAutoComplete.tsx`: typing `/` at the **start** of the composer opens a
menu listing available skills, filtered as the user types, with keyboard +
mouse selection. This is the chat-shaped surface (§5), not a button row.

### 4. Skill discovery (feeds the menu)

The menu needs a source of skill names. A small HTTP route scans the
workspace's `.claude/skills/*/SKILL.md` (project + user skills) plus the
backend's bundled skills, returning name + description for the autocomplete.
Follow the project's `add-endpoint` pattern (service → route → client hook).

This is the only genuinely new infra. Changes #1 + #2 ship the capability;
#3 + #4 layer on discoverability and can follow.

## Build order

1. #1 + #2 — preserve leading slash, allowlist `Skill`. Unblocks invocation.
2. #4 — skill-discovery endpoint.
3. #3 — `/` autocomplete in the composer, fed by #4.

## Scope boundary

This doc covers **skill invocation only**. The broader slash-command layer —
`/goal` as a native cross-turn feature, Bucket 1 interception (`/diff`,
`/review`, `/clear`), Bucket 2 session-setting commands (`/model`, `/plan`) —
remains doc 132. The `/` autocomplete machinery built here (#3/#4) is the same
surface doc 132 needs, so it is a shared foundation rather than throwaway work.

## Tests

- Unit: prompt builder keeps `/skill` at index 0 with and without file/image
  attachments; non-slash messages keep context prepended as before.
- Unit: `Skill` present in `AUTO_TOOLS` and `NORMAL_TOOLS`, absent in
  `PLAN_TOOLS`.
- Client: autocomplete opens on a leading `/`, filters by query, inserts the
  selected skill name.

## Key files

- `src/server/orchestrator/ws-handlers/agent-execution.ts` — prompt assembly
  (Blocker 1 / change #1)
- `src/server/session/claude.ts` — `--allowedTools` allowlists (Blocker 2 /
  change #2)
- `src/client/components/MessageInput.tsx`, `FileAutoComplete.tsx` — `/`
  autocomplete (change #3)
- `docs/132-slash-commands/plan.md` — the broader slash-command layer this
  slice was carved from
- `docs/096-claude-skills-access/plan.md` — skill *authoring* access (done)

## Open questions

- Should `PLAN_TOOLS` allow `Skill`? Default here is no (read-only plan mode),
  but a read-only skill the user explicitly invokes in plan mode would be
  denied. Revisit if users hit it.
- Skill discovery scope: project-only, or also the backend's bundled skills
  (e.g. `/loop`, `/simplify`)? Bundled set is per-backend, so it belongs
  behind the `AgentCapabilities` map doc 132 introduces.
