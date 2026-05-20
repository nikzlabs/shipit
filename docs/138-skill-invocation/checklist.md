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

- [x] `Skill` added to `AUTO_TOOLS` in `claude.ts` (also covers `guarded` mode,
      which reuses `AUTO_TOOLS`)
- [x] `Skill` added to `PLAN_TOOLS` in `claude.ts` (explicit invocation honored
      in plan mode by design)
- Note: there are only **two** `--allowedTools` lists (`AUTO_TOOLS`,
  `PLAN_TOOLS`), not three — earlier drafts referenced a nonexistent
  `NORMAL_TOOLS`. The three permission *modes* are `auto`/`guarded`→`AUTO_TOOLS`
  and `plan`→`PLAN_TOOLS`.
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

**(a) Project skills (host-side, trivial)**

- [ ] Repoint `listSkills()` Codex branch from `.codex/prompts/*.md` →
      `.codex/skills/*/SKILL.md` (reuse the Claude frontmatter parser:
      `name`/`description`, honor `user-invocable: false`). Stays in
      `services/skills.ts` — the workspace is bind-mounted, so an orchestrator
      `fs` scan still works.
- [ ] Update `skills.test.ts` Codex cases for the new directory + `SKILL.md`
      shape

**(b) Built-in skills (worker-side — NEW infra)**

- [ ] Built-in Codex skills live at `~/.codex/skills/**` *inside the container*
      (`CODEX_HOME` is unset → defaults to `/root/.codex`). The orchestrator
      cannot `fs.readdir` this — orchestrator↔container is HTTP-only. Add a
      **session-worker endpoint** (`session-worker.ts`) that scans
      `~/.codex/skills/**/SKILL.md` inside the container and returns the list.
- [ ] `GET /api/sessions/:id/skills` route merges host-scanned project skills
      (`source: "project"`) + worker-scanned built-ins (`source: "bundled"`).
      No `AgentCapabilities` map needed for Codex (unlike Claude bundled skills).
- [ ] Worker-endpoint test + route-merge test.

**(c) Composer**

- [ ] Keep `/` as the universal trigger that opens the menu for both backends;
      on Codex, **selecting inserts `$name `** (vs `/name ` for Claude). Thread
      the active agent's insert-prefix into `SkillAutoComplete.tsx` (trigger
      char stays `/`; only the inserted token differs).
- [ ] Accept the known limitation: after a Codex selection inserts `$name`, the
      leading char is `$`, so *editing* the token won't re-open the menu (the
      open regex matches a leading `/` only). Out of scope unless we also
      register `$` as a Codex trigger — note in code, don't silently ship.
- [ ] Client test: autocomplete inserts `$name` under the Codex agent.

**(d) Cleanup / no-op confirmations**

- [ ] Refresh the stale `.codex/prompts` references in the `skills.ts` module
      docstring + `scanCodexPrompts`, and the `SkillInfo.source` doc comment in
      `domain-types.ts`, to describe `.codex/skills/*/SKILL.md` + `$name`.
- [ ] Confirm no `codex-adapter.ts` change is required (catalog injection is
      automatic); leave a code comment / doc note recording the dropped inlining
      design so it isn't re-litigated.

## Cross-cutting

- [ ] `npm run lint` + `npm run typecheck` clean after #5
- [ ] Flip `plan.md` `status: in-progress` → `done` once #5 ships and the
      bundled-skills item (#4) is unblocked or explicitly deferred
