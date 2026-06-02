---
description: Bake an explicit Claude CLI settings.json into agent containers declaring allowed and denied tool paths, replacing fragile implicit permission defaults.
issue: https://linear.app/shipit-ai/issue/SHI-36/explicit-session-agent-permissions
---
# 097 — Explicit Session-Agent Permissions

## Summary

Make the Claude CLI's permission posture inside ShipIt session containers **explicit** instead of relying on the CLI's default headless behavior. Bake a `~/.claude/settings.json` into agent containers (or pass an equivalent `--settings` flag) declaring exactly which tools and file patterns are permitted.

This is a code-change-as-documentation effort. Today's behavior doesn't break anything, and we don't need this to fix any current bug. We need it because:

1. **Today's permissive editing relies on CLI defaults**, not on ShipIt's intent. If the Claude CLI ever ships a more restrictive default (e.g., adding per-path prompts in headless mode), every ShipIt session breaks silently. We currently have no signal that would catch that.
2. **The intent is invisible.** A new contributor reading `claude.ts` sees `--allowedTools "Write,Read,Edit,..."` and has to know that "no path restriction = unrestricted edits." A settings.json makes the policy declaratively visible: "Edit is allowed for `**`, but NOT for `~/.config/**`," for example.
3. **There's no reason for the dev-loop and the session agent to use different mechanisms.** Feature 096 added `.claude/settings.json` to govern Claude Code (the dev tool) when working on ShipIt. The same shape of file should govern the agent that ShipIt itself runs — symmetry is easier to reason about.

## Motivation

The follow-up question that prompted feature 096 was "ShipIt should always allow editing skills inside ShipIt." Investigation revealed that the **session agent** (`src/server/session/claude.ts`) already does, by virtue of `Edit` being in `--allowedTools` with no path restriction. The block was actually in the dev-loop layer (Claude Code) and was solved by `.claude/settings.json` in the project root.

But "already allowed by the CLI default" is a fragile guarantee. We are one Claude CLI release away from learning that the default changed. Right now we have no:
- Test that fails when the agent loses Edit access.
- Visible policy declaration in the repo.
- Lever to tighten the policy if we ever wanted to (e.g., forbid Edit on `node_modules/**`).

This feature converts the implicit policy into an explicit one — same observable behavior today, much better posture.

## Design

### Option A — Bake `~/.claude/settings.json` into the agent image (recommended)

Add a `settings.json` to the session-worker container image (under the home dir, e.g., `/root/.claude/settings.json`). The Claude CLI inside the container reads it on every invocation. ShipIt's existing `claude.ts` code path is unchanged.

Pros:
- Single source of truth, mountable as a read-only volume.
- Survives CLI default changes — explicit allowlist.
- No CLI-flag plumbing.

Cons:
- Needs a Dockerfile / image bake step (or a runtime mount via `buildMounts()`).
- Two places to update if the policy changes (one for image, one for the dev-loop file in 096) — though we can share the file via a symlink in CI.

### Option B — Mount a settings.json from the host at container creation

Drop `src/server/shipit-docs/agent-settings.json` (or similar) into the session-worker baked-in directory tree, then mount it into each session container via `buildMounts()` in `src/server/orchestrator/container-lifecycle.ts`. The orchestrator can dynamically generate the JSON if needed (e.g., per-session permission overrides) and write it to the session's host-side state dir before mounting.

Pros:
- No image rebuild required.
- Per-session customization is straightforward (e.g., a "strict" session that disallows Bash).
- Mount target is well-known (`/root/.claude/settings.json`).

Cons:
- One more host-side file to manage.
- If the host-side file is missing/malformed, sessions silently fall back to the CLI default — same fragility we're trying to fix.

### Option C — Pass `--settings <path>` to the CLI invocation

Modify `src/server/session/claude.ts` to point the CLI at an inlined or per-session settings file. Generated either at orchestrator startup or per-session. Pros/cons similar to B but the file lives next to the CLI invocation in code, making it easy to pin via a constant.

### Recommendation

**Option A**, with the settings file checked in to `src/server/session/agent-settings.json` (or similar) and copied into the image at build time. The bake-in step is a one-liner in the Dockerfile/build script. Per-session overrides are out of scope here — if we ever need them, layer Option B on top.

### What the policy should say

Verbatim today's effective behavior, plus the few obvious deny rules. Starting point:

```json
{
  "permissions": {
    "allow": [
      "Edit(**)",
      "Write(**)",
      "Read(**)",
      "Bash(*)",
      "Glob(**)",
      "Grep(**)",
      "WebFetch(*)",
      "WebSearch(*)",
      "AskUserQuestion(*)"
    ],
    "deny": [
      "Edit(/root/.claude/**)",
      "Write(/root/.claude/**)",
      "Edit(/credentials/**)",
      "Write(/credentials/**)"
    ]
  }
}
```

Rationale for the deny list:
- **`/root/.claude/**`** — the agent should not rewrite its own permission file or session credentials.
- **`/credentials/**`** — ShipIt's auth bind mount; the agent should never touch it.

The deny list is the meat of this work. Everything else is essentially codifying the status quo.

## Migration / rollout

1. Land the settings file (whichever path is chosen).
2. Wire it up via the chosen option (A/B/C). Ship to one canary session pool.
3. Verify via integration test: spawn a session, attempt an edit on a denied path, assert the CLI refuses or returns an error event.
4. Roll out to all sessions.

No data migration. No client changes. The only runtime effect is some operations now produce explicit "permission denied" events instead of succeeding silently — which is the whole point.

## Test plan

- Unit: parser test for the policy file (round-trips, deny-overrides-allow, etc.) — only if we generate it dynamically.
- Integration: session boots, agent attempts a denied edit, asserts the operation is refused and no file change occurs on disk.
- Regression: existing session-worker integration tests should pass unchanged (status quo edits still permitted).

## Risks

- **Schema drift.** The Claude CLI's settings.json schema may change between versions. Today we follow the documented `permissions.allow` / `permissions.deny` shape. If the schema changes, our explicit settings file becomes wrong and falls back to default behavior. Mitigation: add a smoke test that asserts a denied operation actually fails — if the test starts passing the deny rule (a wrong file silently ignored), CI catches it.
- **Over-broad deny.** A too-aggressive deny rule breaks legitimate operations users expect. Start with the minimal deny list above and only tighten after measurement.
- **Per-session override demand.** Users might want "strict mode" sessions. Out of scope here — but the design (Option A baked-in default + Option B host-mounted override) leaves room.

## Out of scope

- Per-session permission overrides (defer until requested).
- UI for inspecting / editing the policy from inside ShipIt.
- Codex agent permissions (`codex-adapter.ts` doesn't expose equivalent knobs — separate feature if/when needed).

## Key files (when implemented)

| File | Role |
|---|---|
| `src/server/session/agent-settings.json` (new) | The baked-in policy, copied into the agent container image |
| `src/server/session/claude.ts` | (Possibly) `--settings` flag added to CLI invocation, depending on which option lands |
| `src/server/orchestrator/container-lifecycle.ts` | If Option B/C: `buildMounts()` adds the settings file mount |
| Dockerfile / image build script | If Option A: copy step |
| `src/server/orchestrator/integration_tests/agent-permissions.test.ts` (new) | Smoke test for denied operations |

## Relationship to other features

- **096 — `.claude/skills/` access**: solves the same problem at the dev-loop layer. This feature is the symmetric fix at the session-agent layer.
- **094 — merge conflicts (cont'd) / 095 — runner-ctx simplification**: unrelated to permissions, but share the WS-lifecycle hardening pattern. None of those features depend on this one or vice versa.
