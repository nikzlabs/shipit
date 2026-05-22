---
status: planned
priority: medium
description: Let Codex ask multiple-choice questions in ShipIt by enabling its request_user_input tool and bridging it to the AskUserQuestion UI.
---

# Codex question tool (`request_user_input`)

## Problem

Codex cannot ask the user multiple-choice questions inside ShipIt. When the
model tries, the user sees a plain-text fallback like:

> I can't use the question tool from this mode: `request_user_input` is
> unavailable in Default mode.

Claude has this via its `AskUserQuestion` tool (rendered by
`AskUserQuestion.tsx`); Codex has the equivalent tool (`request_user_input`)
but it never reaches the UI.

## Root cause (verified end-to-end against `codex app-server`, 0.130 in-container and 0.132 on host)

The message comes from Codex's own tool router (`codex_core::tools::router:
error=request_user_input is unavailable in Default mode`), **not** from ShipIt.
Two independent gates block the feature:

1. **The tool is not enabled.** `request_user_input` is gated behind the
   experimental feature `default_mode_request_user_input`
   (`stage: underDevelopment`, `defaultEnabled: false`). By default the tool is
   **only available in Plan mode**. ShipIt runs every turn in Default mode (so
   the agent can edit files — Plan mode is read-only), so the tool is never
   offered to the model. The model hits the router error and emits the
   plain-text fallback.

   - It is **not** runtime-settable via `experimentalFeature/enablement/set`
     (that API only accepts `apps, memories, mentions_v2, plugins,
     remote_control, tool_search, tool_suggest, tool_call_mcp_elicitation`).
   - It **is** settable at spawn via `--enable default_mode_request_user_input`
     (equivalent to `-c features.default_mode_request_user_input=true`).
     Confirmed present and accepted on the pinned **0.130** CLI in the
     production container, so no CLI bump is required.
   - The transport feature `tool_call_mcp_elicitation` is already `stable` /
     `enabled: true` by default, so no extra flag is needed there.

2. **ShipIt rejects the tool even when enabled.** When `request_user_input`
   fires, the app-server sends a **blocking server→client JSON-RPC request**
   `item/tool/requestUserInput`. The adapter's `handleServerRequest`
   (`codex-adapter.ts`) currently replies with `-32601 "Method not handled by
   ShipIt"` for any method outside the approval cases. So enabling the flag
   *alone* would make turns fail when the model asks — worse than the current
   plain-text fallback. The flag and the handler must land together.

This is independent of live steering (docs/140) — it happens on every
Default-mode turn. Steering only made it visible because the user was
mid-conversation when they asked Codex to use the question tool.

## Verified wire protocol

Enable at spawn:

```
codex app-server --enable default_mode_request_user_input
```

(emits a one-time `warning` notification per session: "Under-development
features enabled…". Suppress with `-c suppress_unstable_features_warning=true`
if the noise matters; the adapter already logs `warning` notifications.)

Server → client (blocks the turn until answered):

```jsonc
{ "method": "item/tool/requestUserInput", "id": 0, "params": {
    "threadId": "019e…", "turnId": "019e…", "itemId": "call_VBE…",
    "questions": [{
      "id": "setting_name",
      "header": "Setting",
      "question": "What should the setting be named?",
      "isOther": true,      // free-text "Other" allowed
      "isSecret": false,    // secret/password-style answer
      "options": [
        { "label": "darkMode (Recommended)", "description": "…" },
        { "label": "theme", "description": "…" }
      ]
    }]
} }
```

Client → server (the answer — this is the RESPONSE to the request id, NOT a new
turn input):

```jsonc
{ "id": 0, "result": { "answers": [{ "optionIndex": 0 }] } }
```

After we respond, the app-server emits `serverRequest/resolved`
(`{ requestId }`) and the turn continues. The `answers` array is parallel to
`questions` (one answer per question). `optionIndex` selects an option; for an
`isOther: true` free-text answer the shape is a custom-text variant (confirm
the exact field — likely `customText`/`text` — by probing before relying on
it; the index path is verified, the free-text path is not yet).

This shape is close to — but **not** 1:1 with — ShipIt's existing
AskUserQuestion model, so the adapter must transform it:

- The client renders questions purely from a normal `tool_use` content block
  where `tool.name === "AskUserQuestion" && Array.isArray(tool.input.questions)`
  (`message-tools.tsx:111`). There is **no** distinct "question" AgentEvent —
  the adapter must emit an `agent_assistant` event carrying an
  `AgentContentBlock` of `{ type: "tool_use", name: "AskUserQuestion", input: {
  questions: [...] } }`. Emit the **raw** `AskUserQuestion` name (the client
  matches that literal string); do **not** use the `tool-map.ts` `ask_user`
  normalization here — that's a different layer and would not render as a
  question.
- `AskQuestionItem` (`AskUserQuestion.tsx`) requires `question`, `header`,
  `options[].label`, `options[].description`, **and `multiSelect: boolean`**.
  Codex's questions carry `id`, `header`, `question`, `isOther`, `isSecret`,
  `options[].label/description` — there is **no `multiSelect`** and no
  guaranteed `description`. The adapter must synthesize `multiSelect: false`
  per question and a `description` fallback (`""`) where Codex omits it. Codex
  `id`/`isOther`/`isSecret` are dropped from the UI block but `id`/`isOther`
  must be remembered for the answer mapping (see step 4); `isSecret` has no UI
  affordance today (open question below).

## Contrast with Claude's answer flow (the integration wrinkle)

For Claude, `AskUserQuestion` is a normal tool call in the stream, and the
answer is delivered as the **next user message** — `handleAnswerQuestion`
(`send-message.ts:357`) routes it via `sendUserMessage` (steering) or
`writeStdin`/`--resume`.

For Codex, the answer must be sent back as the **JSON-RPC response to the
blocked `item/tool/requestUserInput` request** within the same turn. Reusing
the Claude text path would not satisfy the pending request — the turn would
hang. So the answer routing needs a Codex-specific branch.

## Implementation plan

### 1. Enable the tool at spawn (`codex-adapter.ts`)
- `const args = ["app-server", "--enable", "default_mode_request_user_input"]`
  (line ~330). Optionally add `-c suppress_unstable_features_warning=true`.
- Add a `codex-adapter.test.ts` assertion that the spawn args include the flag.

### 2. Handle `item/tool/requestUserInput` (`codex-adapter.ts handleServerRequest`)
- Add a case for `item/tool/requestUserInput`: stash the pending request on the
  adapter (`pendingUserInputId` plus the original `questions` — needed to
  reverse-map answers in step 4), and emit an **`agent_assistant`** event whose
  content is a `tool_use` block named `AskUserQuestion` with
  `input.questions` transformed per the rule above (raw name, synthesized
  `multiSelect: false`, `description` fallback). The block's `id` should be the
  Codex `itemId` (`call_…`) so it flows through as `toolUseId` — the client's
  `answer_question` echoes `toolUseId` (`ws-client-messages.ts:17`).
- Do **not** fall through to the `-32601` default for this method.
- Decide a timeout/cancel story: if the turn is interrupted or the agent is
  disposed while a request is pending, reply with an error/cancel so the
  app-server doesn't wait forever, and clear `pendingUserInputId`.

### 3. Expose an answer method on the agent interface
- Add a **distinct** `answerUserInput(answers)` to the `AgentProcess` interface
  — which lives in `src/server/shared/types/agent-types.ts:241` (NOT
  `agent-process.ts`, which only re-exports). Implement in `codex-adapter.ts`,
  `claude-adapter.ts`, and `proxy-agent-process.ts`.
  - Do **not** "generalize"/reuse `sendUserMessage`: Codex's `sendUserMessage`
    (`codex-adapter.ts:425`) already maps to `turn/steer`, which is a different
    message than the JSON-RPC **response** a pending `requestUserInput` needs.
    Conflating them would either send a steer (ignored by the blocked request)
    or break steering.
  - Codex impl: send `{ id: pendingUserInputId, result: { answers } }` via
    `sendResponse`, then clear `pendingUserInputId`. If nothing is pending,
    no-op (this is what makes the orchestrator-side routing in step 4 safe).
  - Claude impl: no-op (Claude answers via the existing text/`--resume` path).
- Proxy it: `POST /agent/answer` on `session-worker.ts` + `worker-http.ts`, and
  delegate through `ProxyAgentProcess` + `container-session-runner.ts`. Mirror
  the existing `sendUserMessage` chain: `ProxyAgentProcess.sendUserMessage` →
  `ContainerSessionRunner.sendAgentMessage` → `workerPostMessage` → worker
  `POST /agent/message` → in-container `agent.sendUserMessage`.

### 4. Route answers in `handleAnswerQuestion` (`send-message.ts:357`)
- **Routing decision.** The orchestrator has no "a question is pending" state
  today — for Claude the non-streaming path just interrupts and waits for any
  `answer_question` (`agent-listeners.ts:477-485`), and `handleAnswerQuestion`
  keys off `getAgent()` + steering capability. The pending request lives on the
  **in-container Codex adapter** (`pendingUserInputId`), invisible to the
  orchestrator. So route by **agent id** — when the active agent is `codex`
  (`getActiveAgentId() === "codex"`), call `answerUserInput`; the adapter
  no-ops if nothing is pending (step 3), so this is safe even if the routing
  fires spuriously. Do **not** invent an orchestrator-side pending flag.
- **Answer reverse-mapping (the trickiest part).** The client sends
  `WsAnswerQuestion.answers` as `Record<string, string>`
  (`ws-client-messages.ts:18`) — keyed by question-index string, valued by the
  selected option **label text** (not an index), with multi-select selections
  comma-joined into one string and "Other" free-text folded into the same
  value (see `deriveAnswersFromResult` in the client). The Codex branch must,
  per question: look up the label in the stashed `questions[i].options` to
  recover `optionIndex`; if the value doesn't match any label and the question
  had `isOther: true`, treat it as free-text (confirm the free-text wire shape
  — see open questions). Produce `{ answers: [<per-question answer>] }`
  parallel to the original `questions`.

### 5. Tests
- `codex-adapter.test.ts`: spawn includes `--enable …`; an inbound
  `item/tool/requestUserInput` emits a question event and does NOT get a
  `-32601`; answering sends `{ id, result: { answers } }`.
- Integration test (mirror `ask-user-question.test.ts`): Codex turn →
  question surfaces → answer → turn resumes (no hang).

### 6. Docs
- Update `src/server/shipit-docs/` if Codex question behavior becomes part of
  the agent-facing contract.
- Note the dependency on the `default_mode_request_user_input` upstream feature
  (currently `underDevelopment`) — if a future CLI bump removes/renames it, the
  CLI contract test (docs/141) should catch the spawn-flag rejection.

## Open questions
- Exact wire shape for an `isOther` free-text answer (index path verified;
  free-text path needs a probe).
- `isSecret: true` handling — does ShipIt's question UI support a masked input?
- Interaction with live steering (docs/140): a pending `request_user_input`
  blocks the turn; confirm steering/interrupt while a question is open behaves
  sanely (likely: answering is the only way forward, or interrupt cancels the
  pending request).

## Key files
- `src/server/session/agents/codex-adapter.ts` — spawn flag (~330), `handleServerRequest` (559; reject case 573-580), `sendUserMessage`→`turn/steer` (425), new `answerUserInput`
- `src/server/shared/types/agent-types.ts` — `AgentProcess` interface (241); add `answerUserInput`
- `src/client/components/message-tools.tsx` — `AskUserQuestion` tool_use → UI match (111)
- `src/server/shared/types/ws-client-messages.ts` — `answer_question` payload shape (16-19)
- `src/server/session/session-worker.ts`, `src/server/orchestrator/worker-http.ts` — proxy endpoint
- `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts` — delegation
- `src/server/orchestrator/ws-handlers/send-message.ts` — `handleAnswerQuestion` routing (357)
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — Claude's interrupt-and-wait answer path (477-485), for contrast
- `src/client/components/AskUserQuestion.tsx` — `AskQuestionItem` shape (requires `multiSelect`), reused question UI
- `src/server/session/agents/tool-map.ts` — tool-name normalization (`AskUserQuestion`→`ask_user`); NOT the rendering path, do not emit `ask_user`
