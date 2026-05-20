# 138 — Skill Invocation — Checklist

Tracks all work for explicit skill invocation across both backends. See
`plan.md` for the design and the empirical Codex findings.

## #1 — Preserve leading slash (Claude) — DONE

- [x] Extract prompt ordering into pure `assembleAgentPrompt()` in
      `agent-execution.ts`
- [x] Slash/skill invocations append file + image context *after* the command
      (token stays at index 0); non-slash messages keep context prepended
- [x] Unit coverage in `agent-prompt.test.ts` (with/without attachments,
      non-slash regression)

## #2 — Allowlist `Skill` (Claude) — DONE

- [x] `Skill` added to `AUTO_TOOLS` in `claude.ts`
- [x] `Skill` added to `NORMAL_TOOLS` in `claude.ts`
- [x] `Skill` added to `PLAN_TOOLS` in `claude.ts` (explicit invocation honored
      in plan mode by design)
- [x] `Skill`-allowlist cases in `claude.test.ts`

## #4 — Project skill discovery — DONE (project half)

- [x] Pure `listSkills(dir, agentId)` service in `services/skills.ts`
- [x] Claude branch scans `.claude/skills/*/SKILL.md`, parses
      `name`/`description`, excludes `user-invocable: false`
- [x] `GET /api/sessions/:id/skills[?agent=]` route (agent = session lock-in →
      `?agent=` override → server default)
- [x] `SkillInfo.source` distinguishes `"project"` vs `"bundled"`
- [x] Service tests (`skills.test.ts`) + route tests (`Integration: Skills`)
- [ ] **Bundled skills** half — blocked on doc 132's `AgentCapabilities` map;
      layer bundled entries into the route once available (no client change
      needed, `source` already discriminates)

## #3 — Composer `/` autocomplete (Claude) — DONE

- [x] `SkillAutoComplete.tsx` mirrors `FileAutoComplete` (keyboard + mouse)
- [x] Opens on leading `/` at start of composer, filters by query
- [x] Selecting inserts `/<name> ` keeping the token at index 0
- [x] Fed by `useFileStore.skills`, fetched on session connect + agent switch
- [x] `skill autocomplete` cases in `MessageInput.test.tsx`

## #5 — Codex backend — TODO (small slice; design revised)

Empirically re-verified (codex-cli 0.132.0): **no adapter inlining needed** —
`codex exec` injects a `<skills_instructions>` catalog and reads `SKILL.md`
itself. `.codex/prompts/*.md` is deprecated upstream and does not expand
headless.

- [ ] Repoint `listSkills()` Codex branch from `.codex/prompts/*.md` →
      `.codex/skills/*/SKILL.md` (reuse the Claude frontmatter parser:
      `name`/`description`, honor `user-invocable: false`)
- [ ] Update `skills.test.ts` Codex cases for the new directory + `SKILL.md`
      shape
- [ ] Composer autocomplete inserts `$name ` for Codex (vs `/name ` for Claude);
      thread the active agent's token prefix into `SkillAutoComplete.tsx`
- [ ] Confirm no `codex-adapter.ts` change is required (catalog injection is
      automatic); leave a code comment / doc note recording the dropped inlining
      design so it isn't re-litigated
- [ ] Client test: autocomplete inserts `$name` under the Codex agent
- [ ] Also surface Codex's built-in system skills from `$CODEX_HOME/skills/*`
      (e.g. `.system/imagegen`, `skill-creator`) in the menu — tag them
      `source: "bundled"`. Note: unlike Claude's bundled skills (which need doc
      132's `AgentCapabilities` map), Codex built-ins are filesystem-discoverable
      via the same `SKILL.md` scan, so no capabilities map is required for Codex.

## Cross-cutting

- [ ] `npm run lint` + `npm run typecheck` clean after #5
- [ ] Flip `plan.md` `status: in-progress` → `done` once #5 ships and the
      bundled-skills item (#4) is unblocked or explicitly deferred
