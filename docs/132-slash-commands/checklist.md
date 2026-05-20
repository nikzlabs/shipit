# 132 — Slash Commands — Checklist

Status verified against the codebase on 2026-05-20. The plan's build order
has 5 steps; step 1 shipped as doc 138, the rest are unstarted.

## Build order 1 — Skill invocation + `/` autocomplete (doc 138)

> Carved out into doc 138 (`status: done`). This is the shared `/`-autocomplete
> foundation the rest of doc 132 builds on.

- [x] Preserve leading `/` in prompt assembly (`assembleAgentPrompt()` in `agent-execution.ts`)
- [x] Allowlist `Skill` in `AUTO_TOOLS` + `PLAN_TOOLS` (`claude.ts`)
- [x] `GET /api/sessions/:id/skills` project-skill scan (`services/skills.ts`)
- [x] `SkillAutoComplete.tsx` composer menu (opens on leading `/`, inserts `/name ` / `$name `)
- [x] Codex skills support (`.codex/skills/*/SKILL.md` + worker `GET /codex/skills`)

> ⚠️ Note: autocomplete currently lists **skills only**, not the recognized
> commands below. The menu must be extended to surface Bucket 1/2/4 commands
> once the registry exists.

## Build order 2 — Agent-agnostic command registry + `AgentCapabilities`

- [ ] New shared command registry (sibling to `agent-registry.ts` / `tool-map.ts`)
      mapping normalized command name → `{ bucket, handler, per-backend availability }`
- [ ] Add available-command set to `AgentCapabilities` (`agent-types.ts`), the way
      doc 125 added `supportsReview`
- [ ] Populate per-backend command availability for Claude + Codex
- [ ] Feed the command set into the `/` autocomplete menu (extend `SkillAutoComplete`
      / `useFileStore`)
- [ ] Tests: registry resolution, per-backend filtering

**Status: NOT STARTED.** No command registry exists; `AgentCapabilities` has no
command field (current fields: `supportsResume`, `supportsImages`,
`supportsSystemPrompt`, `supportsPermissionModes`, `supportedPermissionModes`,
`toolNames`, `models`, `supportsReview`).

## Build order 3 — Bucket 1 interception in `send-message.ts`

- [ ] Intercept recognized Bucket 1 commands before `runAgentWithMessage` and
      route to the existing ShipIt feature (no agent turn started)
      - [ ] `/diff` → Monaco diff panel
      - [ ] `/review` `/security-review` → doc 125 review flow
      - [ ] `/rewind` `/checkpoint` `/undo` → git rollback
      - [ ] `/usage` `/cost` `/stats` → `UsageManager`
      - [ ] `/resume` `/continue` `/clear` `/new` `/reset` `/branch` `/fork` → session list / branching
      - [ ] `/rename` → `session-namer.ts`
      - [ ] `/config` `/settings` `/theme` `/status` → settings store
      - [ ] `/memory` `/init` → CLAUDE.md editing
      - [ ] auth / config-editor commands as applicable
- [ ] Unrecognized `/foo` → warn in composer instead of sending literal prompt
- [ ] Tests: interception routes to feature; unrecognized warns; normal text untouched

**Status: NOT STARTED.** `send-message.ts` passes `userText` straight to
`runAgentWithMessage` with no slash detection. No unrecognized-command warning.

## Build order 4 — Bucket 2 session-setting commands

- [ ] `/model` → set session model (storage already exists: `sessions.setModel`)
- [ ] `/plan` → `--permission-mode plan`
- [ ] `/effort`, `/fast` → spawn-arg / session setting
- [ ] Optionally continue with remaining text as a prompt after applying the setting
- [ ] (Open Q) also reachable from a settings panel
- [ ] Tests

**Status: PARTIAL.** Session `model` storage + spawn-arg wiring exist
(`sessions.ts`, `claude.ts`, `codex-adapter.ts`), but no slash-command shorthand
routes to them.

## Build order 5 — `/goal` native feature

- [ ] Persist goal on session metadata (`sessions.ts`, `domain-types.ts` `SessionInfo`)
- [ ] Inject goal into agent context each turn (`agent-instructions.ts`)
- [ ] Inline goal banner/card in chat surface + `/goal clear`
- [ ] WS message / store wiring for goal set/clear
- [ ] Backend-agnostic (ShipIt construct, not a proxy of either CLI's `/goal`)
- [ ] Tests

**Status: NOT STARTED.** No `goal` field on `SessionInfo`, no injection in
`agent-instructions.ts`, no goal UI component.

## Open questions (from plan.md)

- [ ] Bucket 2 commands also reachable from a settings panel? (leaning: both)
- [ ] `/compact` — trigger the CLI's own compaction vs. ShipIt's own summarization?
      Needs adapter-capability investigation.
- [ ] `/goal` rendering: dedicated banner vs. reuse scratchpad (`docs/106-session-scratchpad`)?
