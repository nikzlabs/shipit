---
issue: https://linear.app/shipit-ai/issue/SHI-156
description: How each agent backend discovers and auto-discloses project skills — Claude and Codex both read .claude/skills/, the rule for trimming CLAUDE.md, and how to verify a new backend (Cursor CLI, etc.) before relying on it.
---

# 209 — Cross-agent skill disclosure

## Summary

ShipIt is agent-agnostic: Claude Code is the default backend, Codex is
supported, and more (Cursor CLI, etc.) may be added. Two surfaces feed an agent
its standing instructions:

1. **The always-on instruction file** — `CLAUDE.md`, read on *every* turn.
   `AGENTS.md` is a **symlink** to `CLAUDE.md`, so Codex (and any backend that
   reads `AGENTS.md`) gets the exact same file. One file, both backends.
2. **Project skills** — progressive-disclosure docs under a skills directory.
   The agent's harness surfaces each skill's `name` + `description` at startup
   and the model expands the body **on demand** when a task matches.

This doc records **how skills reach each backend's model**, because the answer is
not obvious from the repo's own config — and getting it wrong silently drops
architectural knowledge for one backend. It also defines the rule for what may
be **demoted** out of `CLAUDE.md` into skills (to keep `CLAUDE.md` under the
~40k-char performance cap) without favoring either agent.

## The key finding (verified empirically, 2026-06-15)

**In ShipIt, the Codex agent auto-discloses the skills in `.claude/skills/` —
the same directory Claude reads. No `.codex/skills/` is required.**

Verified by running Codex via `shipit agent run --agent codex` and asking it to
report its own startup context, twice:

| Test | `.codex/skills` present? | Result |
|---|---|---|
| 1 | yes (symlink → `.claude/skills`) | All 12 project skills surfaced; source reported as `/workspace/.claude/skills/`; **auto-disclosed by description** |
| 2 | **no** (removed) | **Still** all 12 surfaced from `/workspace/.claude/skills/` |

Codex's own description of the mechanism: *"The skill descriptions are in my
startup context, and my instructions say to use a skill when the task clearly
matches its description, not only when the user explicitly names it."* That is
the same progressive-disclosure model Claude uses — so a skill genuinely reaches
the Codex *model mid-task*, not merely as a user-typed `$skill-name` command.

### What this means for trimming `CLAUDE.md`

- **Reference-grade detail may be demoted into `.claude/skills/`** (or into the
  `docs/NNN-*` it already cites — `docs/` is read by both backends on demand via
  the filesystem). Both backends pick it up. **No symlink, no `.codex/skills/`,
  no duplicated copy is needed.**
- **Load-bearing always-on invariants stay in `CLAUDE.md`.** Skills are
  on-demand for *both* backends, so anything that must be in context every turn
  — e.g. "WebSocket lifecycle MUST NOT affect server behavior", "Chat transcript
  content MUST be persisted" — belongs in `CLAUDE.md`, which is shared with Codex
  via the `AGENTS.md` symlink.

The trim that motivated this doc (CLAUDE.md from 53.7k → under 40k) applied
exactly this split: invariants kept, recipes/overviews condensed to a takeaway +
a pointer into the skill or `docs/NNN-*` that holds the full detail.

## The mechanism — observed, not guaranteed by repo code

There is an apparent contradiction worth flagging so a future change doesn't
silently break this:

- `AgentCapabilities.skillsDirName` is `.claude` for Claude and **`.codex`** for
  Codex (`src/server/shared/agent-registry.ts`). But that field only feeds **two
  ShipIt-side things**: the composer's `/`-autocomplete (`services/skills.ts`
  `listSkills`) and the merge of Codex's **bundled** system skills scanned from
  `~/.codex/skills/**` *inside the container* (`session-worker.ts` →
  `GET /codex/skills`). It does **not** govern what the agent's own CLI harness
  reads for project skills.
- Empirically, the **Codex CLI harness reads `.claude/skills/`** for project
  skills in this environment. The most likely explanation is upstream Codex-CLI
  cross-compatibility with the `.claude` convention (the same convergence that
  has Codex read `AGENTS.md`). This repo's code does not *configure* it, so treat
  it as **observed behavior, not a guarantee**: a future Codex-CLI release could
  change it.

If a Codex-CLI upgrade ever stops surfacing `.claude/skills/`, the fix is a
one-line committed symlink `.codex/skills → ../.claude/skills` (the repo already
commits the analogous `AGENTS.md → CLAUDE.md` symlink, and the scanner —
`fs.readdir` in `shared/skill-scan.ts` — follows a symlinked directory
transparently). That keeps a single source of truth with zero duplication.

## Adding a new backend (Cursor CLI, etc.) — the checklist

Before relying on skills (or demoting `CLAUDE.md` detail into them) for a new
backend, **verify its disclosure behavior empirically** — don't assume:

1. **Does it read the always-on file?** Confirm the backend reads `AGENTS.md`
   (→ `CLAUDE.md` symlink) or `CLAUDE.md` directly. If it reads neither, add its
   convention as a symlink to `CLAUDE.md` (mirror the `AGENTS.md` precedent).
2. **Where does it read *project* skills, and does it *auto-disclose* them?**
   Probe it the way this doc did:

   ```
   shipit agent run --agent <backend> --prompt-file - <<'EOF'
   Read-only diagnostic about your own harness. Report:
   1. Were project "Agent Skills" surfaced to you at startup? List names + the
      on-disk directory they came from, or say "NONE SURFACED".
   2. If I asked a task matching one skill's description without naming it,
      would it be auto-surfaced by description, or require explicit invocation?
   EOF
   ```

   - **Auto-discloses from `.claude/skills/`** (like Codex): nothing to do —
     skills and demoted detail already reach it.
   - **Reads only its own `<skillsDirName>/skills`**: add a committed symlink
     `<dir>/skills → ../.claude/skills` so it shares the single skill set.
   - **Does not auto-disclose** (only user-invoked): treat skills as *not*
     reaching that backend's model mid-task. Keep anything it must know in
     `CLAUDE.md`, and don't demote backend-critical detail into skills for it.
3. **Update `AGENT_DEFS`** in `src/server/shared/agent-registry.ts` with the new
   backend's `skillsDirName` / `skillInvocationPrefix`, and update this doc's
   findings table with what you observed.

## Key files

- `src/server/shared/agent-registry.ts` — `AGENT_DEFS`; per-backend
  `skillsDirName` / `skillInvocationPrefix`.
- `src/server/orchestrator/services/skills.ts` — `listSkills`; scans
  `<dir>/<skillsDirName>/skills` for the composer autocomplete (ShipIt-side, not
  the agent harness).
- `src/server/shared/skill-scan.ts` — `scanSkillsDir`; `fs.readdir`-based, so it
  follows a symlinked skills root.
- `src/server/session/session-worker.ts` — `GET /codex/skills`; merges Codex's
  bundled `~/.codex/skills/**` system skills (separate from project skills).
- `AGENTS.md` → `CLAUDE.md` — the committed symlink that shares the always-on
  instruction file across backends.
- `.claude/skills/**` — the single project-skills source both Claude and Codex
  read.

## Related

- `docs/138-skill-invocation` — explicit `/skill-name` invocation reaching the
  Claude CLI in print mode.
- `docs/155-agent-abstraction-hairs` — the agent-abstraction seams that make
  ShipIt backend-agnostic.
- `docs/138-per-agent-credential-isolation` — why `shipit agent run` is the only
  authenticated way to invoke another backend.
