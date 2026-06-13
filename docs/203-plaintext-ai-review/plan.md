---
issue: https://linear.app/shipit-ai/issue/SHI-136
title: Plain-text AI review + cross-agent reviewer
description: Replace the structured submit_review_comments flow with a plain-text review rendered as one persisted card; route to a different agent when Multi-agent sessions is on.
---

# Plain-text AI review + cross-agent reviewer

> **Status:** design. Supersedes the AI-review half of `docs/125-chat-native-ai-review`
> and `docs/151-agent-review-cards`. The **user-comment** half of those docs (a
> human leaving inline notes and sending them to the implementation agent) is
> **kept and decoupled**, not removed.

## Goal

Two changes that compound into one simpler review system:

1. **Plain-text AI review.** The reviewer returns a **markdown review as plain
   text** — exactly the shape a `shipit agent run` sub-agent already returns —
   instead of calling the structured `submit_review_comments` MCP tool with
   line/selection-anchored comments. The findings render as a single, persisted
   **review card** in chat. No anchored comments, no immutable doc snapshot, no
   snapshot viewer.

2. **Cross-agent reviewer when Multi-agent is on.** When **Settings →
   Multi-agent sessions** (`enableSubAgents`) is enabled *and a different agent
   is signed in*, the review is delegated to **that other agent** via
   `shipit agent run` (a genuine cross-model second opinion). Otherwise it runs
   under a fresh-context `Task` subagent, as today. The reviewer is resolved
   **at button-press time** on the client — the prompt is concrete, not
   self-correcting.

## Why

- The `submit_review_comments` path is the fragile part. The current prompt
  spends ~20 lines making the tool-call reliable ("call it exactly once", "empty
  array means it ran", "echo the tool result verbatim"). Plain text removes all
  of that ceremony.
- Anchored AI comments + the immutable snapshot viewer are rarely revisited, so
  the heavy subsystem (~25 files: an MCP tool, an agent-review store, a
  draft/send cycle for AI output, line/selection anchoring, a snapshot modal
  mode) is paying for value that isn't used.
- Plain text makes the **same-model** path and the **cross-model** path
  *identical in shape*: spawn reviewer → get markdown → render card → parent
  applies fixes → re-review. That is the entire reason `shipit agent run`
  returns plain text.
- A different model reviewing is a strictly stronger form of the bias-avoidance
  the current flow already aims for ("you likely wrote this file, so don't
  review it yourself"). Review is already the canonical consumer of the
  sub-agent primitive (`services/sub-agent.ts` docstring; `docs/144`).

## Principle: two independent systems

These were entangled (`composeReviewMessage` embedded the user's draft comments
into the AI-review prompt). They are now **fully separate**:

| System | Direction | Trigger | Output |
|---|---|---|---|
| **User comments** | user → implementation agent | leave inline comments, then **Send comments** | a normal chat message to the session's own agent |
| **AI review** | reviewer → user | **Ask agent to review** / `/review` | one **review card** + parent-applied fixes |

The only change to the **user-comment** system is decoupling: the AI-review
prompt no longer embeds draft comments. The inline-comment UI, `file-review-store`,
and the draft/send endpoints stay exactly as they are.

## AI review flow (new)

### 1. Resolve the reviewer on the client (at click time)

When **Ask agent to review** is pressed (or `/review` is sent), the client
already knows, from bootstrap:

- `enableSubAgents` (the Multi-agent setting), and
- the agent registry — the current **pinned** agent plus which **other** agents
  are `installed && authConfigured`.

From those it picks a reviewer mode:

- `enableSubAgents` **and** a *different* agent is signed in → **cross-agent**,
  naming that agent (`reviewerAgentId`).
- otherwise → **subagent** (fresh-context `Task` under the same model).

This resolution happens in the click handlers (`App.tsx` `/review` path and
`handleAskAgentReview`), reading the settings store + registry, and is passed
into `composeReviewMessage`.

### 2. Compose the prompt

`composeReviewMessage(filePath, { mode, reviewerAgentId })`:

- **cross-agent**: instruct the parent to run
  `shipit agent run --agent <reviewerAgentId> --prompt-file -` with the review
  brief, get the reviewer's markdown back, then **submit it** (step 4) and apply
  fixes.
- **subagent**: instruct the parent to spawn one fresh `Task` subagent with the
  same brief, get its markdown, then submit + fix.
- **No draft-comment embedding** — that logic moves out (it belongs to the
  user-comment system only).

The **review brief** (identical in both modes) asks the reviewer to return
**markdown only**:
- material issues only (correctness, safety, completeness, the stated goal) —
  skip nits and style;
- severity-ordered list; each finding as `path:line — issue` (line optional,
  rendered clickable in chat);
- a specific fix named for each finding, or omit it;
- "No material issues found." when clean.

No MCP tool call by the reviewer — it just returns text.

### 3. Parent applies fixes + re-reviews

Kept from today (this is the useful half): the reviewer's markdown is **input**,
not the final answer. The parent applies fixes for material findings, runs one
fresh re-review, fixes only new blockers/regressions, then summarizes in chat.

### 4. The review card

The **parent** (which always has the ShipIt MCP server) calls a single minimal
tool, **`submit_review`**, with `{ file_path, markdown }`. This replaces
`submit_review_comments`. The difference that matters: the payload is **one
freeform markdown string**, not a structured comment array — none of the
"anchor each comment / echo verbatim" fragility. The parent is always the
caller, so the card path is identical in both reviewer modes.

`submit_review` emits the card through the established **side-channel card**
pattern (see `CLAUDE.md` → "Chat transcript content MUST be persisted"):
`emitChatCard` → new `PersistedMessage.aiReview` field → column + `toRow`/`fromRow`
+ migration → rehydrate in `loadSessionHistory` → register in
`CARD_MESSAGE_FIELDS` → history round-trip + no-dup-on-replay tests.

**Card contents** (read-only, scannable; see `mockup.html`):
- target file path;
- reviewer label — "Reviewed by Codex" / "Reviewed by a subagent";
- the markdown findings (collapsible);
- timestamp.

No line anchoring, no snapshot content, no **Open** into the modal.

## What gets removed (full replacement)

- `submit_review_comments` MCP tool → reshaped to `submit_review`
  (`src/server/session/mcp-tools/review.ts`); `mcp-shipit-bridge.ts` registry
  entry updated (tool id `review` retained).
- AI-side comment types — `AgentReview`, `AgentReviewComment`, the `source: "ai"`
  branch of `ReviewComment` (`domain-types.ts`). **Human** `FileReview` /
  `ReviewComment` stay for the user-comment system.
- `AgentReviewCard.tsx` + the FilePreviewModal `agent-review` snapshot mode →
  replaced by a new text **ReviewCard**.
- `agent-review-store.ts` (immutable snapshots) — removed.
- `chat-history.ts`: `agentReview` field → `aiReview` (markdown). `userReview`
  stays.
- WS messages `WsAgentReviewAdded` / `WsReviewUpdated` (AI side) → one
  `ai_review_added`; client handlers swapped to match.
- `api-routes-reviews.ts` / `services/reviews.ts`: drop the anchoring submit
  path; add the markdown submit relay. **Keep** the user draft/send endpoints.
- `composeReviewMessage`: drop draft embedding; add `mode`/`reviewerAgentId`.

## Files touched

**Server**
- `src/server/session/mcp-tools/review.ts` — `submit_review_comments` → `submit_review`
- `src/server/session/mcp-shipit-bridge.ts` — registry (id unchanged)
- `src/server/session/agent-ops-routes.ts` — relay path for markdown submit
- `src/server/orchestrator/api-routes-reviews.ts` — submit relay; keep user endpoints
- `src/server/orchestrator/services/reviews.ts` — markdown submit; drop anchoring
- `src/server/orchestrator/agent-review-store.ts` — **remove**
- `src/server/orchestrator/chat-history.ts` — `agentReview` → `aiReview` (+ migration)
- `src/server/shared/types/domain-types.ts` — remove `AgentReview*`, AI branch of `ReviewComment`
- `src/server/shared/types/ws-server-messages.ts` — `ai_review_added`
- `src/server/shipit-docs/agent.md` — note the review-shaped consumer

**Client**
- `src/client/utils/compose-review-body.ts` — mode/reviewer; drop draft embedding
- `src/client/App.tsx` — resolve reviewer at click time (`/review` + `handleAskAgentReview`)
- `src/client/components/FilePreviewModal.tsx` — remove `agent-review` mode; keep user-comment UI
- `src/client/components/AgentReviewCard.tsx` → new `ReviewCard.tsx` (text)
- `src/client/hooks/message-handlers/agent-review-added.ts` / `review-updated.ts` → `ai-review-added.ts`
- `src/client/components/visual-elements.ts` — `CARD_MESSAGE_FIELDS` += `aiReview`
- `src/client/utils/session-data.ts` — rehydrate `aiReview` in `loadSessionHistory`
- `src/client/stores/file-review-store.ts` — unchanged (user comments only)

**Tests / docs**
- Rewrite: `review-chat-native.test.ts`, `services/reviews.test.ts`,
  `compose-review-body.test.ts`, the card/handler tests; add `aiReview` to
  `EVERY_OPTIONAL_FIELD_MESSAGE` (`chat-history.test.ts`).
- Update `docs/125` + `docs/151` headers to point here for the AI-review half.

## Visual reference

`mockup.html` — the plain-text review card (collapsed + expanded, both reviewer
labels).

## Open questions / risks

- **`chat_history` migration**: old rows carry `agent_review` JSON. Either keep
  the column readable for backfill display or drop it (acceptable — old anchored
  cards degrade to "review ran"). Decide during implementation.
- **Reviewer return path**: a `Task` subagent returns via the tool result; a
  `shipit agent run` reviewer returns via stdout. Both already deliver text to
  the parent — no new transport.
- **`submit_review` availability**: the parent always has the ShipIt MCP server
  (`review` is in `SHIPIT_MCP_TOOLS` for both adapters), so the card path holds
  in both modes.
