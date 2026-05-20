---
status: planned
priority: medium
---

# Claude Code "auto" mode (LLM command-safety classifier) as a third ShipIt permission mode

## Summary

Claude Code shipped a permission mode (`--permission-mode auto`, GA research preview
since 2026-03-24) in which a **separate classifier model** reviews each tool call
*before* it runs and blocks anything risky, instead of prompting the human. This is a
natural fit for ShipIt's headless, autonomous, container-based agent model — it adds an
LLM safety net to autonomous execution without introducing a per-tool approval UI (which
§5 of CLAUDE.md forbids anyway).

This doc plans adding it as a **third** ShipIt permission mode alongside today's two
(`auto`, `plan`), and works through the naming, the CLI-value collision, availability
detection + graceful fallback, headless-abort handling, and how the abstraction maps onto
Codex (which has a different, non-classifier permission model).

## Background: how Claude's auto mode works

Sources: [permission-modes docs](https://code.claude.com/docs/en/permission-modes),
[engineering deep dive](https://www.anthropic.com/engineering/claude-code-auto-mode),
[announcement](https://claude.com/blog/auto-mode).

- **Decision order** (first match wins): (1) explicit allow/deny rules → (2) read-only
  actions + working-directory file edits auto-approved (classifier skipped) → (3)
  everything else (shell, network, out-of-dir writes, protected-path writes) goes to the
  classifier → (4) if blocked, Claude receives the reason as a tool result and "finds a
  safer path."
- **Two-stage classifier** (server-side model, independent of `/model`; reported as
  Sonnet 4.6): a fast single-token filter that errs toward blocking, then a
  chain-of-thought stage only on flagged actions. End-to-end ≈0.4% false-positive,
  **≈17% false-negative** — i.e. it still lets ~1 in 6 genuinely dangerous actions
  through. **It is not a safety guarantee**; it is prompt-fatigue reduction with a net.
- **Injection defenses**: the classifier sees user messages + tool *calls* + CLAUDE.md,
  but **not** tool results. A separate server-side probe screens tool results before
  Claude reads them.
- **Blocked by default**: `curl|bash`, prod deploys/migrations, force-push, push to
  `main`, mass cloud deletion, IAM grants, irreversibly destroying pre-session files,
  exfiltrating secrets. **Allowed by default**: working-dir file ops, installing declared
  deps, read-only HTTP, pushing to the session branch / a branch Claude created.
- **Conversation boundaries**: statements like "don't push until I review" are treated as
  block signals and persist until lifted — aligns well with ShipIt's chat-as-input model.
  (Caveat: boundaries are re-read from the transcript each check, so context compaction
  can drop them. Not a hard guarantee.)
- **Blanket allow rules are dropped on entering auto**: `Bash(*)`, wildcarded interpreters
  (`Bash(python*)`), package-manager run commands, and `Agent` allow rules are removed
  (restored on leaving). Narrow rules like `Bash(npm test)` carry over. **This means our
  `--allowedTools Bash` blanket grant is dropped and all Bash routes through the
  classifier — which is exactly the intent.**
- **Hooks still run.** `PreToolUse` is independent of the classifier, so our existing
  branch-op block hook (`/etc/shipit/agent-hooks/block-branch-ops.mjs`) survives.

### Hard requirements (the availability matrix)

| Requirement | Value | ShipIt status |
|---|---|---|
| CLI version | **v2.1.83+** | ✅ container ships **2.1.145** (verified) |
| Plan | Max, Team, Enterprise, or API — **NOT Pro** | ⚠️ depends on the user's subscription |
| Model | Sonnet 4.6 / Opus 4.6 / Opus 4.7 (Opus 4.7 only on Max) | ⚠️ must intersect with our model lineup |
| Provider | **Anthropic API only** (not Bedrock/Vertex/Foundry) | ✅ OAuth subscription qualifies |
| Admin | Team/Enterprise admin must enable; can hard-lock via `permissions.disableAutoMode` | ⚠️ out of our control |

"Auto mode unavailable" is a **non-transient** signal (a requirement is unmet) and is
distinct from a transient "cannot determine the safety of an action" classifier outage.
We must treat these differently (see Fallback).

### Headless (`-p`) behavior — the critical caveats

We always run `claude -p` (headless). Two things matter:

1. **Repeated blocks abort the session.** Interactive mode pauses auto and reverts to
   prompting after 3 consecutive / 20 total blocks; in `-p` mode there is no human to
   prompt, so **the session aborts**. We must catch this and surface it inline (the
   denial reasons) rather than failing silently.
2. **Opt-in / activation in headless is the #1 open risk.** The docs describe an
   interactive opt-in prompt when *cycling* into auto. It is **not documented** whether
   `claude -p --permission-mode auto` activates cleanly or trips an opt-in/refusal in our
   PTY. **This must be spiked empirically before building the UI** (see Open questions).

## Current ShipIt state (blast radius)

`PermissionMode = "auto" | "plan" | "normal"` — `src/server/shared/types/attachment-types.ts:29`.
Three values exist in the type, but the UI is a **binary toggle** and `"normal"` is
effectively **dead** (backend-only, exercised solely by a legacy test).

| ShipIt mode | CLI flag today | Tool allowlist | Meaning |
|---|---|---|---|
| `auto` (default) | *(none)* | `Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,mcp__playwright__*` (+ user MCP) | Full autonomy, **no LLM safety check** — relies on the allowlist + branch hook. Effectively bypass-scoped-to-allowlist; safe only because the container is isolated. |
| `plan` | `--permission-mode plan` | read-only subset | Research/plan, no edits. |
| `normal` | *(none)* | read-only subset | **Dead.** Injects a "use AskUserQuestion before acting" system prompt. Not reachable from the UI. |

Key files where mode is consumed:
- `src/server/session/claude.ts:71-86,104-115` — allowlist selection, `--permission-mode`
  pass-through (plan only), normal-mode system-prompt injection.
- `src/server/session/agents/claude-adapter.ts:34,184` — declares supported modes,
  forwards to `ClaudeProcess.run()`.
- `src/server/session/agents/codex-adapter.ts:106-107` — `supportsPermissionModes: false`,
  `supportedPermissionModes: []`.
- `src/server/shared/agent-registry.ts:35,50` — capability registration per agent.
- `src/server/shared/types/agent-types.ts:23,130` — `AgentCapabilities.supportedPermissionModes`,
  `AgentRunParams.permissionMode`.
- `src/server/shared/types/ws-client-messages.ts:12` — `WsSendMessage.permissionMode`.
- `src/server/orchestrator/ws-handlers/send-message.ts:58,269` — extracts + queues it.
- `src/server/orchestrator/session-runner.ts:60` — `QueuedMessage.permissionMode`.
- Client: `src/client/components/PlanModeToggle.tsx` (binary toggle),
  `src/client/components/MessageInput.tsx:27`, `src/client/stores/settings-store.ts`
  (`permissionMode` default + `permissionModeBySession` map, **not persisted** by design),
  `src/client/App.tsx:149-153,359-362,393-394,437-438` (resolves per-session mode; omits
  the field from `send_message` when it equals `"auto"`),
  `src/client/components/PlanApproval.tsx:36` (resets to `"auto"` after plan approval).
- Tests: `src/server/orchestrator/integration_tests/permission-modes.test.ts`,
  `src/client/components/PlanModeToggle.test.tsx`,
  `src/client/stores/settings-store.test.ts`,
  `src/server/session/agents/claude-adapter.test.ts:42`.

## Naming (let's iterate)

We are **keeping** `auto` and `plan` and **adding a third**. The new mode is the
genuinely-classifier-gated one. The internal name **cannot** be `auto` (taken) even though
the CLI value we pass for it *is* `auto`. So there is a deliberate, documented inversion:

| ShipIt internal mode | CLI value passed | One-liner |
|---|---|---|
| `plan` | `--permission-mode plan` | Read-only. |
| **`guarded`** *(new — recommended)* | `--permission-mode auto` | Autonomous, **every shell/network action LLM-safety-checked**; unsafe ones blocked and Claude re-routed. |
| `auto` | *(none)* | Autonomous, **no** safety check (current behavior, unchanged). |

Oversight ladder (most → least): `plan` → `guarded` → `auto`.

### Name candidates for the new mode

| Candidate | For | Against |
|---|---|---|
| **`guarded`** ✅ recommended | Short, accurate ("guarded autonomy"), no overlap with existing terms, reads well in a 3-way selector. | Doesn't say *what* guards it. |
| `safe` / `safe-auto` | Most discoverable. | Overstates it — 17% FNR is not "safe"; risks false confidence. Avoid. |
| `checked` | Accurate (each action is checked). | Bland; collides mentally with CI "checks". |
| `vetted` / `shielded` | Evocative. | Less conventional. |
| `supervised` | Matches the dead `normal` mode's intent. | Implies a *human* supervises; here it's a model. Confusing. |

**Recommendation: `guarded`.** UI label "Guarded mode", tooltip e.g. "Autonomous —
commands are safety-checked by Claude before running; risky ones are blocked."

### Also recommended: delete the dead `normal` mode

`normal` is unreachable from the UI and only kept alive by one test. Removing it while we
touch the type keeps the union honest (`"auto" | "plan" | "guarded"`). This is optional
but reduces confusion; call it out for the reviewer. (Its supervised-prompt code in
`claude.ts:106-111` would go too.)

## Design

### 1. Type + capabilities
- `attachment-types.ts`: `PermissionMode = "auto" | "plan" | "guarded"` (drop `normal`).
- `agent-registry.ts` + `claude-adapter.ts`: Claude's `supportedPermissionModes`
  becomes `["auto", "plan", "guarded"]`.
- Codex stays `supportsPermissionModes: false` (see Codex section).

### 2. `claude.ts` — spawn wiring
- Tool allowlist for `guarded`: **reuse `AUTO_TOOLS`** (incl. user MCP globs). Auto mode
  drops the blanket `Bash` grant and routes Bash/network through the classifier; Write/Edit
  in the working dir are tier-2 auto-approved. (Verify empirically that keeping the
  allowlist doesn't suppress the classifier vs. removing it — see Open questions.)
- Pass the flag: extend the branch at `:84-86` so `guarded` → `--permission-mode auto`.
- No system-prompt injection for `guarded` (the classifier *is* the mechanism, and auto
  mode already nudges Claude to keep working without clarifying questions).

### 3. Availability detection + graceful fallback (per CLAUDE.md §1/§2 — surface inline, never link out)
The user's plan/model/admin state can make `guarded` unavailable for **non-transient**
reasons. Strategy:
- **Attempt-and-detect.** Spawn with `--permission-mode auto`; if the CLI emits the
  non-transient "auto mode unavailable" signal, (a) surface an inline chat message
  explaining *why* it's unavailable and that we're falling back, (b) **fall back to today's
  `auto`** behavior for that turn, and (c) remember per-session that `guarded` is
  unavailable so we stop offering it / auto-fall-back silently next time.
- **Transient classifier outage** ("cannot determine the safety of an action") is handled
  differently: do not permanently disable; surface a transient notice.
- Detection lives in `ClaudeProcess`/`claude-adapter` parsing of the stream/stderr; the
  resolved availability is emitted back to the client to drive the selector's enabled state.
  *(Exact detection strings/exit semantics: TBD in the spike — see Open questions.)*

### 4. Headless-abort handling (`agent-execution.ts`)
- When `-p` aborts due to repeated classifier blocks (3 consecutive / 20 total),
  surface an inline chat message listing the denial reason(s) and suggesting either
  rephrasing, stating a narrower scope, or switching to `auto` for the action — rather
  than a silent/confusing turn failure. Reuse the post-turn message-emission path
  (`runner.emitMessage`, not `ctx.send`).

### 5. Client UI — replace the binary toggle with a 3-state selector
- `PlanModeToggle.tsx` is binary (auto↔plan). Replace with a 3-state control
  (`plan` / `guarded` / `auto`) — segmented control or a Shift-Tab-style cycle consistent
  with ShipIt's design language. `guarded` is shown **disabled with an explanatory
  tooltip** when the session has detected it as unavailable.
- `App.tsx`: today the field is omitted from `send_message` when it equals `"auto"`. Keep
  that, and send `"guarded"`/`"plan"` explicitly.
- `settings-store.ts`: defaults unchanged (`"auto"` stays the **default** — `guarded` is a
  research preview with availability constraints, so we do not make it the default).
  `permissionModeBySession` already scopes per session.
- `PlanApproval.tsx`: the "Approve and start in auto mode" path could optionally offer
  "Approve in guarded mode" (mirrors Claude's own plan-approval options). Nice-to-have.

### 6. Usage / cost note
Classifier calls count toward the user's token usage and add a round-trip before
shell/network actions. `UsageManager` already tracks per-session cost; no special handling
needed, but note it in the mode's tooltip/help so users understand `guarded` is slightly
slower and costs a bit more than `auto`.

### 7. shipit-docs
Update `src/server/shipit-docs/` if any agent-facing doc describes permission behavior, so
the in-container agent reference matches.

## Codex: investigated — different model, no classifier

Codex has **no LLM command-safety classifier**. Its safety is two orthogonal axes
([OpenAI Codex docs](https://developers.openai.com/codex/agent-approvals-security),
[sandboxing](https://developers.openai.com/codex/concepts/sandboxing)):

- **`approval_policy`** (how often it asks a *human*): `untrusted` / `on-request` /
  `on-failure` / `never`.
- **`sandbox_mode`** (how far it can reach): `read-only` / `workspace-write` /
  `danger-full-access`. `--full-auto` = `on-request` + `workspace-write`.

The closest analog to ShipIt `guarded` would be human-in-the-loop approval
(`on-request`/`untrusted`) — which **does not fit** ShipIt's headless autonomous model.
There is no model-classifier equivalent, so **`guarded` is Claude-only for now**.

**Current Codex reality in ShipIt:** the adapter spawns `codex app-server`
(`codex-adapter.ts:191`) and starts turns via JSON-RPC `turn/start` with **no**
`approvalPolicy` / `sandboxMode` params (`codex-adapter.ts:569-583`) — it inherits the
app-server defaults. It declares `supportsPermissionModes: false`, so ShipIt's mode
selector is ignored for Codex sessions entirely.

**Implication for the UI:** the mode selector must be **agent-aware** — for a Codex
session, `guarded` (and arguably `plan`) should be hidden/disabled, since Codex advertises
no permission modes. (Today the binary toggle ignores agent capability; this is a latent
gap we should close while building the 3-state selector.)

**Future work (out of scope here):** map ShipIt modes onto Codex's axes by passing
`sandboxMode`/`approvalPolicy` in `turn/start` — e.g. `plan` → `read-only`,
`auto` → `workspace-write` (or `danger-full-access`) with `approval_policy: never`. That
would let Codex honor `plan`/`auto`; it still can't offer `guarded`.

## Touchpoints checklist

- [ ] Spike: confirm `claude -p --permission-mode auto` activates headlessly without an
      interactive opt-in (and capture the exact unavailable/outage signals).
- [ ] `attachment-types.ts`: add `guarded`, drop `normal`.
- [ ] `agent-registry.ts`, `claude-adapter.ts`: update `supportedPermissionModes`.
- [ ] `claude.ts`: allowlist for `guarded`, `--permission-mode auto` pass-through, remove
      `normal` system-prompt injection.
- [ ] `claude-adapter.ts` / `claude.ts`: parse + emit availability (non-transient
      unavailable vs transient outage); fall back to `auto`.
- [ ] `agent-execution.ts`: handle headless abort-on-repeated-blocks, surface inline.
- [ ] Client: 3-state, **agent-aware** selector replacing `PlanModeToggle`; disabled state
      for unavailable `guarded`; `App.tsx` send wiring; `settings-store` (default stays
      `auto`); optional `PlanApproval` "approve in guarded" option.
- [ ] `src/server/shipit-docs/`: update if permission behavior is documented there.
- [ ] Tests: extend `permission-modes.test.ts` (guarded → `--permission-mode auto`,
      fallback path); update `PlanModeToggle.test.tsx` (3-state + agent-aware +
      disabled-unavailable); `claude-adapter.test.ts` capability; remove `normal` test.
- [ ] `npm run lint` + `npm run typecheck`.

## Spike results — verified in a container (CLI 2.1.145, `--model sonnet`)

Ran `claude -p … --permission-mode auto --output-format stream-json --verbose` directly
in the session container. **Risks #1, #2, #3 below are resolved:**

- **Headless activation works, no opt-in.** Exit 0; the turn ran to completion. The
  `system`/`init` stream event reports **`"permissionMode": "auto"`** — this is the
  authoritative detection signal that auto actually engaged. (Note: an earlier
  `system`/`subtype:"status"` event reports `permissionMode:"default"` — ignore it; read
  the `init` event.) This account/plan/model **supports** auto mode (no unavailable error).
- **Classifier engages and blocks.** Prompted to append to `~/.bashrc`; the model attempted
  the Bash call and it was **blocked**. The block surfaces two ways:
  - `result.permission_denials[]` → `{ tool_name, tool_use_id, tool_input }` for each
    blocked call. This is the array to count for the 3-consecutive / 20-total abort logic.
  - The model receives a textual reason ("…blocked because `~/.bashrc` is flagged as a
    sensitive file. You can either approve the permission when prompted, or run it
    yourself…") and re-routes / reports. **A single block does NOT abort the turn**
    (still exit 0).
- **Allowlist interaction confirmed.** `--allowedTools "Bash"` did **not** pre-approve the
  `.bashrc` write — auto mode drops the blanket `Bash` grant and routes it to the
  classifier, exactly as documented. ⇒ **Reusing `AUTO_TOOLS` for `guarded` is correct.**
- **Model self-refusal is separate from the classifier.** A `git push --force origin main`
  prompt was refused by the model itself before any tool call (empty `permission_denials`).
  Integration must not conflate model refusals with classifier denials — only
  `permission_denials[]` represents a classifier block.
- `claude auto-mode {config,defaults,critique}` subcommands exist and run locally (no
  auth/token cost); `defaults`/`config` dump the allow / soft_deny / hard_deny rule sets —
  useful for surfacing "why was this blocked" context inline.

Reproduction is preserved conceptually above; scratch dirs were under `/tmp` (outside the
repo) and cleaned up.

## Open questions / risks

1. ~~**Headless activation.**~~ ✅ Resolved by spike: activates cleanly, `init` event
   reports `permissionMode:"auto"`.
2. **Availability "unavailable" signal (partially open).** This account *supports* auto, so
   the spike could not capture the **non-transient unavailable** error shape (Pro plan /
   admin-locked / unsupported model). Detection should be: treat `init.permissionMode ===
   "auto"` as success; if a run requested auto but `init.permissionMode !== "auto"` (or the
   CLI errors), classify as unavailable and fall back. Capture the exact error string when
   we can test on a Pro account, or handle defensively via the init-field check.
3. ~~**Allowlist interaction.**~~ ✅ Resolved: blanket Bash dropped → classifier-gated.
4. **Abort-after-N-blocks (untested).** Docs say 3 consecutive / 20 total blocks abort a
   `-p` session; a single block does not (verified). The multi-block abort path wasn't
   exercised (would need 3+ forced blocks). Build the inline handler per docs and verify
   later.
5. **Model intersection.** Ensure the models ShipIt offers for Claude include at least one
   auto-mode-supported model (Sonnet 4.6 / Opus 4.6 / Opus 4.7); otherwise `guarded` is
   unavailable regardless of plan. Cross-check with the model lineup from commit
   `9b81f8f4c`.
5. **Default stays `auto`.** Research-preview status + availability constraints argue
   against defaulting to `guarded`. Revisit once it's GA and broadly available.
