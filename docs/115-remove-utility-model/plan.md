---
status: done
---

# Remove the configurable utility model

The "utility model" was originally a separately-configured small model (OpenAI-compatible / Anthropic API) used for AI-powered session naming. As of `371572e6` (PR #384) it gained a third option: `claude-cli`, which shells out to the locally installed Claude Code CLI using the same OAuth credentials as the coding agent.

That third option makes the whole settings card obsolete. The CLI is universally installed in both the orchestrator and session-worker images (`docker/Dockerfile.{dev,prod}` and `docker/Dockerfile.session-worker.{dev,prod}` both run `npm install -g @anthropic-ai/claude-code @openai/codex`), and the user is already authenticated with Claude — so there's no reason to ask them to configure a separate provider/API-key for branch naming. This aligns with the CLAUDE.md product principles (§5: chat is the input surface; the agent is the actor): naming should be invisible infrastructure, not a settings knob.

## What changes

- Delete the **Utility Model** card from Settings.
- Delete the three `/api/settings/utility-model` endpoints (GET/PUT/DELETE).
- Drop the `utilityModel` field from `CredentialStore`, along with its `UtilityModelConfig` and `UtilityModelProvider` types and the `getUtilityModel`/`setUtilityModel`/`clearUtilityModel` methods.
- Simplify `session-namer.ts`: remove `callOpenAICompatible`, `callAnthropic`, the `UtilityModelConfig` parameter, and the provider switch. Keep only `callClaudeCli`. Signature becomes `generateSessionName(userMessage: string)`.
- Simplify `ws-handlers/send-message.ts`: drop the `getUtilityModel()` gate; always call `generateSessionName(userText)`. The "no utility model" branch goes away — fallback handling stays (CLI failure still no-ops the rename).

## Behavior change

Before: AI-powered session naming was an opt-in feature that required the user to configure a provider and (for hosted providers) an API key. Most users never configured it, so most sessions kept their placeholder title (first 60 chars of the message) and the random `shipit/<6-char-slug>` branch name.

After: every session gets an AI-generated title and slug-prefixed branch name on first message. There's no off switch — if the user is logged into Claude (which they must be, to use ShipIt at all), they get session naming. If the CLI call fails, naming silently no-ops (existing fallback path, unchanged).

This shifts a tiny amount of cost (a one-shot Haiku prompt per warm-session graduation) onto the user's Claude subscription. That's an intentional trade — naming is small and the UX win of "every session has a real name" outweighs the marginal cost.

## Key files

- **`src/server/orchestrator/session-namer.ts`** — kept; trimmed down to just `callClaudeCli` + the JSON parsing wrapper.
- **`src/server/orchestrator/credential-store.ts`** — `utilityModel` field and methods removed.
- **`src/server/orchestrator/services/settings.ts`** — `setUtilityModel` / `clearUtilityModel` / `VALID_PROVIDERS` removed.
- **`src/server/orchestrator/api-routes-bootstrap.ts`** — three `/api/settings/utility-model` routes removed.
- **`src/server/orchestrator/ws-handlers/send-message.ts`** — `getUtilityModel()` gate removed.
- **`src/client/components/UtilityModelCard.tsx`** — deleted.
- **`src/client/components/Settings.tsx`** — import + render removed.

## Tests

- `src/server/orchestrator/session-namer.test.ts` — pruned to only test the `claude-cli` path and the JSON parsing/fallback logic.
- `src/server/orchestrator/credential-store.test.ts` — `utilityModel` describe block removed.
