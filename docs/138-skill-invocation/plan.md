---
status: in-progress
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

- **Change #1 (preserve leading slash) is Claude-only in effect** — it lives in
  `agent-execution.ts`, upstream of the adapter, so it runs for both backends,
  but it only *matters* for Claude. Codex doesn't do position-sensitive CLI
  expansion (see below), so the token is just prose the model reads; ordering
  is irrelevant on the Codex side.
- **Change #2 (allowlist) is Claude-only** — Codex has no `--allowedTools`.

**Codex uses catalog injection, not textual expansion — re-verified
empirically (codex-cli 0.132.0, `codex debug prompt-input`).** Two findings:

1. **Custom prompts (`.codex/prompts/*.md`) are deprecated and do NOT expand
   headless.** Running `/myprompt hello world` yielded a final user turn of the
   literal string `/myprompt hello world`; the prompt body was never inlined.
   Codex's own docs now say *"Custom prompts are deprecated. Use skills for
   reusable instructions."* So the original "scan `.codex/prompts/`" design is
   targeting a dead feature.
2. **Codex Agent Skills (`.codex/skills/*/SKILL.md`) work in `codex exec`
   natively — no inlining required.** Running `$myskill` did NOT substitute the
   skill body either, BUT `codex exec` automatically injected a
   `<skills_instructions>` block listing every discovered skill (project
   `.codex/skills/*` **and** `$CODEX_HOME/skills/*`) with its name,
   description, and absolute `SKILL.md` path, plus the instruction: *"If the
   user names a skill (with `$SkillName` or plain text) OR the task clearly
   matches a skill's description … you must use that skill for that turn"* by
   opening the `SKILL.md` and following it (progressive disclosure). This
   injection happens automatically in headless mode.

**Consequence — the adapter-level inlining design is dropped.** Codex's skill
mechanism is architecturally different from Claude's: Claude's CLI does textual
`/skill` expansion at the prompt; Codex does **catalog injection + model-driven
file reading**, and it does this itself even under `codex exec`. So
`codex-adapter.ts` needs **no** prompt-expansion engine. The remaining work is
small:

- **Discovery scan moves** from `.codex/prompts/*.md` (deprecated) to
  `.codex/skills/*/SKILL.md` — the same `name`/`description` frontmatter shape
  ShipIt already parses for Claude's `.claude/skills/`, so `listSkills()` can
  reuse almost all of the Claude branch.
- **Token syntax is `$name`, not `/name`.** The composer autocomplete inserts
  `$name ` for Codex vs `/name ` for Claude. Even plain text matching a skill
  description triggers it, so `$` is a discoverability nicety, not a hard
  requirement.
- **No `$ARGUMENTS` substitution** — there is no substitution step. The user's
  literal text (including any trailing args) is already in the prompt for the
  model to read alongside the skill body. This closes the open question below.
- **Implicit invocation comes for free** — because Codex injects the catalog,
  the model can pick a matching skill even without an explicit `$name`.

## Build order

1. ✅ **#1 + #2 — DONE.** Preserve leading slash, allowlist `Skill` (all three
   Claude modes). Unblocks Claude invocation. The prompt-ordering decision is
   extracted as the pure `assembleAgentPrompt()` in `agent-execution.ts` and
   `Skill` is in `AUTO_TOOLS` / `NORMAL_TOOLS` / `PLAN_TOOLS` in `claude.ts`.
   Covered by `agent-prompt.test.ts` and the `Skill`-allowlist cases in
   `claude.test.ts`.
2. ✅ **#4 (project scan) — DONE.** `GET /api/sessions/:id/skills[?agent=]`
   returns user-invocable project skills via the pure `listSkills(dir,
   agentId)` service: Claude scans `.claude/skills/*/SKILL.md` (frontmatter
   `name`/`description`, excluding `user-invocable: false`), Codex scans
   `.codex/prompts/*.md` (filename is the token). The backend is the session's
   locked-in `agentId`, falling back to the `?agent=` override then the server
   default. Covered by `skills.test.ts` (service) and the `Integration:
   Skills` suite (route). The **bundled-skills** half is still blocked on doc
   132's `AgentCapabilities` set — `SkillInfo.source` already distinguishes
   `"project"` vs `"bundled"` so bundled entries can be layered in by the route
   without a client change.
3. ✅ **#3 — DONE.** `SkillAutoComplete.tsx` mirrors `FileAutoComplete`: typing
   `/` at the **start** of the composer opens a filtered menu (keyboard +
   mouse), and selecting inserts `/<name> ` keeping the token at index 0. Fed
   by `useFileStore.skills`, fetched on session connect and on agent switch.
   Covered by the `skill autocomplete` cases in `MessageInput.test.tsx`.
4. #5 — Codex skills support. **No adapter-level inlining** (re-verified:
   `codex exec` injects a skills catalog and reads `SKILL.md` itself). Work is:
   (a) point `listSkills()`'s Codex branch at `.codex/skills/*/SKILL.md`
   instead of the deprecated `.codex/prompts/*.md`; (b) make the composer
   autocomplete insert `$name ` for Codex (vs `/name ` for Claude). Sequenced
   last because Claude is the primary backend, but it is now a *small* slice,
   not the largest.

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
- `src/server/orchestrator/services/skills.ts` — `listSkills()` project scan;
  Codex branch must move from `.codex/prompts/*.md` to `.codex/skills/*/SKILL.md`
  (changes #4 / #5)
- `src/server/orchestrator/api-routes-files.ts` — `GET /api/sessions/:id/skills`
  route (change #4)
- `src/client/components/SkillAutoComplete.tsx` — `/` autocomplete menu, plus
  the wiring in `MessageInput.tsx` and `useFileStore.fetchSkills` (change #3)
- `src/server/session/agents/codex-adapter.ts` — **no change needed** for
  Codex skills (catalog injection is handled by `codex exec` itself); listed
  only to record that the originally-planned inlining was dropped (change #5)
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
- **Both backends in scope** — Claude works via the CLI's own `/skill`
  expansion; Codex works via its native Agent Skills catalog injection (no
  inlining), scanning `.codex/skills/*/SKILL.md` and invoking with `$name`
  (see change #5).
- **Codex skills, not custom prompts** — `.codex/prompts/*.md` is deprecated
  upstream and does not expand headless; ShipIt targets `.codex/skills/` and
  relies on `codex exec`'s automatic `<skills_instructions>` injection.
- **Codex menu lists project + built-in skills** — both project
  `.codex/skills/*/SKILL.md` and Codex's built-in `$CODEX_HOME/skills/*` system
  skills are surfaced (tagged `source: "bundled"`). Both are filesystem-
  discoverable via the same `SKILL.md` scan, so — unlike Claude's bundled
  skills — Codex needs no `AgentCapabilities` map.

## Open questions

- _(Resolved)_ ~~Codex prompt arg semantics / `$ARGUMENTS` substitution~~ — moot
  under the catalog-injection model: Codex reads `SKILL.md` itself and sees the
  user's literal text (including trailing args), so there is no substitution
  step to define.
