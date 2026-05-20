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

### 2. Add `Skill` to the tool allowlists (Claude)

Add `Skill` to **all three** Claude allowlists in `claude.ts` — `AUTO_TOOLS`,
`NORMAL_TOOLS`, **and `PLAN_TOOLS`**. The decision is to honor an explicit
`/my-skill` invocation even in plan mode: when a user deliberately types a
skill command, denying it in plan mode would be a confusing dead end. The
trade-off accepted here is that plan mode is no longer *guaranteed* read-only
— an explicitly-invoked skill may run side-effecting tools. This differs from
the user-MCP-glob exclusion (where the tools are implicit, not user-invoked),
and that asymmetry is intentional.

These changes are the **functional core**: together with #1 they make
`/my-skill` work for any user who already knows the skill name, with or
without attachments, in every permission mode. They are low-risk and shippable
on their own.

Codex has no `--allowedTools` allowlist equivalent (it gates via its
sandbox/approval policy), so there is no Blocker 2 on the Codex side — see
the Codex section below.

### 3. Composer `/` autocomplete (discoverability)

Mirror the existing `@` file-autocomplete in `MessageInput.tsx` /
`FileAutoComplete.tsx`: typing `/` at the **start** of the composer opens a
menu listing available skills, filtered as the user types, with keyboard +
mouse selection. This is the chat-shaped surface (§5), not a button row.

### 4. Skill discovery (feeds the menu)

The menu lists **both** project skills and the backend's bundled skills:

- **Project skills** — scan the workspace's `.claude/skills/*/SKILL.md`
  (Claude) and `.codex/prompts/*.md` (Codex), returning name + description.
- **Bundled skills** — the backend's built-ins (`/loop`, `/simplify`, …).
  These are per-backend, so the set comes from the `AgentCapabilities` map
  (the same map doc 132 introduces), not a filesystem scan. The menu shows
  only what the *active* agent supports.

Exposed via a small HTTP route following the `add-endpoint` pattern (service →
route → client hook). This is the only genuinely new infra. Changes #1 + #2
ship the capability; #3 + #4 layer on discoverability and can follow.

### 5. Codex backend

Skill invocation is **backend-agnostic where it can be**:

- **Change #1 (preserve leading slash) is shared** — it lives in
  `agent-execution.ts`, upstream of the adapter, so it benefits both backends
  with no Codex-specific work.
- **Change #2 (allowlist) is Claude-only** — Codex has no `--allowedTools`.
- **Codex prompt expansion in headless mode is unverified.** Codex's custom
  prompts live in `.codex/prompts/` and are a REPL feature; `codex exec --help`
  shows no `/prompt-name` expansion (in contrast to Claude's documented
  *"Skills still resolve via /skill-name"*). **Before claiming Codex support,
  verify whether `codex exec "/my-prompt"` actually expands the prompt** — if
  it does not, Codex skill invocation needs adapter-level expansion in
  `codex-adapter.ts` (read the prompt file, inline its contents), which is a
  larger task than the Claude path.

## Build order

1. #1 + #2 — preserve leading slash, allowlist `Skill` (all three Claude
   modes). Unblocks Claude invocation.
2. #5 verification — confirm whether `codex exec "/my-prompt"` expands; if
   not, add adapter-level inlining in `codex-adapter.ts`.
3. #4 — skill-discovery endpoint (project scan + bundled-via-capabilities,
   both backends).
4. #3 — `/` autocomplete in the composer, fed by #4.

## Scope boundary

This doc covers **skill invocation only**. The broader slash-command layer —
`/goal` as a native cross-turn feature, Bucket 1 interception (`/diff`,
`/review`, `/clear`), Bucket 2 session-setting commands (`/model`, `/plan`) —
remains doc 132. The `/` autocomplete machinery built here (#3/#4) is the same
surface doc 132 needs, so it is a shared foundation rather than throwaway work.

## Tests

- Unit: prompt builder keeps `/skill` at index 0 with and without file/image
  attachments; non-slash messages keep context prepended as before.
- Unit: `Skill` present in `AUTO_TOOLS`, `NORMAL_TOOLS`, **and** `PLAN_TOOLS`.
- Client: autocomplete opens on a leading `/`, filters by query, inserts the
  selected skill name.

## Key files

- `src/server/orchestrator/ws-handlers/agent-execution.ts` — prompt assembly
  (Blocker 1 / change #1)
- `src/server/session/claude.ts` — `--allowedTools` allowlists (Blocker 2 /
  change #2)
- `src/server/session/agents/codex-adapter.ts` — Codex prompt expansion
  fallback if `codex exec` doesn't expand `/prompt-name` (change #5)
- `src/client/components/MessageInput.tsx`, `FileAutoComplete.tsx` — `/`
  autocomplete (change #3)
- `docs/132-slash-commands/plan.md` — the broader slash-command layer this
  slice was carved from
- `docs/096-claude-skills-access/plan.md` — skill *authoring* access (done)

## Decisions

- **Plan mode allows `Skill`** — an explicit `/my-skill` is honored in every
  permission mode, accepting that plan mode is no longer guaranteed read-only
  (see change #2).
- **Discovery lists project + bundled skills** — filesystem scan plus the
  per-backend `AgentCapabilities` set (see change #4).
- **Both backends in scope** — Claude path is well-grounded; Codex headless
  prompt expansion must be verified first (see change #5).

## Open questions

- Does `codex exec "/my-prompt"` expand the prompt in headless mode? If not,
  Codex needs adapter-level inlining — quantify that work after verification.
