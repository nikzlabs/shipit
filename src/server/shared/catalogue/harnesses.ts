/**
 * docs/252 phase 1 — the harnesses ShipIt can run.
 *
 * A harness is an agent CLI plus the adapter that normalizes its event stream.
 * The set is ShipIt's, not a user's (req 14); which harnesses an *install* has is
 * the `SHIPIT_HARNESSES` build input (phase 9).
 *
 * **Adding a row here means adding one to `docker/agent-cli/install-agent-clis.sh`**
 * — its npm package and its binary — or the image can never install it.
 * `agent-cli-install.test.ts` fails the build if the two disagree.
 *
 * What is NOT here: Cursor CLI. The survey in
 * `docs/252-custom-models/catalogue.md` records what it appears to need — and
 * already paid for itself by making `styles` a set and giving `SpawnShape` a
 * config-file variant — but it is not a harness ShipIt runs, it has no honest
 * `capabilities` block to declare, and req 14 governs what an install actually
 * has. OpenCode and Grok Build both graduated from that survey to rows, via
 * `docs/268-opencode-harness` and `docs/274-grok-build-harness` (empirical
 * findings in each plan.md).
 */

import { CLAUDE_PERMISSION_MODES, GROK_PERMISSION_MODES } from "../types/agent-types.js";
import { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES, GROK_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "../agent-tool-names.js";
import type { HarnessDef } from "./types.js";

export const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    nativeService: "anthropic",
    // VERIFIED (phase 3, CLI 2.1.220, against a local HTTP recorder). Pointed at
    // an arbitrary `ANTHROPIC_BASE_URL` the CLI issues
    // `POST <base>/v1/messages?beta=true` with an Anthropic Messages body — so a
    // service's base URL must NOT carry the `/v1`, which is why DeepSeek's is
    // `…/anthropic` and OpenRouter's `…/api`.
    styles: ["anthropic-messages"],
    spawn: {
      credential: {
        // `ANTHROPIC_API_KEY`, not `ANTHROPIC_AUTH_TOKEN`: the repo distinguishes
        // them as two different reserved routes (`claude-api-key` vs
        // `claude-env-oauth`) and `setApiKey()` writes the former. Verified at
        // the wire in the same run: `ANTHROPIC_API_KEY` becomes an `x-api-key`
        // header and `ANTHROPIC_AUTH_TOKEN` an `Authorization: Bearer` one, which
        // is exactly why `targetOverride` exists and why GLM needs it.
        string: { kind: "env", name: "ANTHROPIC_API_KEY" },
        account: { kind: "scoped-home" },
      },
      // Verified: `--model` is forwarded VERBATIM into the request body. The one
      // exception is the CLI's own `[1m]` suffix, which it consumes to select the
      // long-context variant and strips before sending (`glm-5.2[1m]` arrives as
      // `glm-5.2`) — so the suffix in GLM's row is a Claude-Code instruction, not
      // an id the service ever sees.
      model: { kind: "flag", flag: "--model" },
      endpoint: { kind: "env", name: "ANTHROPIC_BASE_URL" },
    },
    capabilities: {
      supportsResume: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      supportsPermissionModes: true,
      supportedPermissionModes: CLAUDE_PERMISSION_MODES,
      toolNames: [...CLAUDE_TOOL_NAMES],
      // Claude Code CLI `--effort <level>`. Verified valid values by running
      // `claude --effort __bogus__`: "low, medium, high, xhigh, max". Omitting
      // the flag uses the model's adaptive default. See docs/217.
      reasoning: {
        label: "Reasoning",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
      supportsReview: true,
      supportsSteering: true,
      // docs/140 Phase 6.11 — the streaming CLI is ONE resident process across
      // turns, so it can start one ShipIt never asked for.
      startsOwnTurns: true,
      supportsCompaction: true,
      skillsDirName: ".claude",
      skillInvocationPrefix: "/",
    },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    nativeService: "openai",
    // VERIFIED (phase 3, codex-cli 0.146.0, against a local HTTP recorder).
    // Responses is the ONLY style this CLI still speaks: a provider declaring
    // `wire_api = "chat"` is rejected outright with "set `wire_api =
    // \"responses\"` in your provider config", so `openai-chat-completions`
    // could not be added to this set even if a service offered it.
    styles: ["openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "OPENAI_API_KEY" },
        account: { kind: "scoped-home" },
      },
      model: { kind: "turn-payload", field: "model" },
      // Verified: `model_provider` names a block in `model_providers`, it is not
      // a base URL of its own (`-c model_provider=<url>` fails with "Model
      // provider `…` not found"). So the seam is a whole provider block —
      // `name`, `base_url`, `wire_api`, `env_key` — plus `model_provider`
      // pointing at it, which `codex/spawn-shaping.ts` writes. The key here is
      // the base-URL field WITHIN that block; the block's id is the adapter's.
      // Codex appends `/responses` to `base_url`, so a Responses base URL
      // carries its own `/v1` where an Anthropic one does not.
      endpoint: { kind: "config", key: "base_url" },
    },
    capabilities: {
      supportsResume: true,
      supportsImages: false,
      supportsSystemPrompt: true,
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: [...CODEX_TOOL_NAMES],
      // Codex CLI config `model_reasoning_effort`. Verified valid values by
      // running `codex -c model_reasoning_effort=__bogus__`: "none, minimal,
      // low, medium, high, xhigh". See docs/217.
      reasoning: {
        label: "Reasoning effort",
        options: [
          { value: "none", label: "None" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
        ],
      },
      // docs/125 — Codex ships subagents (model-invoked via the `spawn_agent`
      // collab tool) AND MCP servers, so the chat-native review flow works on
      // both backends.
      supportsReview: true,
      supportsSteering: true,
      // docs/140 Phase 6.11 — the app-server is killed at `turn/completed`, and
      // it emits the turn's final assistant text AFTER that. Those late events
      // belong to the turn that just ended, not to a new one.
      startsOwnTurns: false,
      supportsCompaction: true,
      skillsDirName: ".codex",
      skillInvocationPrefix: "$",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    // docs/272 — the follow-up docs/268 deferred: OpenCode's own inference
    // (Zen + Go) now has honest `ServiceDef` rows, so this CLI has a native
    // service. What it buys is attribution — on native + key the metered-spend
    // column may use the harness's OWN figure, and OpenCode reports one (every
    // Zen/Go response body carries a top-level `cost`, docs/272 §5).
    //
    // What it must NOT be read as: unlike claude and codex, this native service
    // has no account machinery — no login flow, no OAuth heal — and an
    // UNSHAPED OpenCode spawn cannot authenticate at all (the adapter refuses a
    // turn with no routing). Three places used "native service" as a stand-in
    // for "the vendor's account machinery owns this", and all three now ask
    // `loginIntegrationForService` as well: `credential-failure-policy.ts`,
    // `session-agent-env.ts` (the planning#353 write and the blocked-turn
    // subject) and `services/settings.ts`. Adding a fourth reader of
    // `nativeService` means asking which of the two questions it wants.
    nativeService: "opencode",
    //
    // VERIFIED (docs/268, CLI 1.18.15, against a local HTTP recorder). A
    // custom provider block with `npm: "@ai-sdk/openai-compatible"` issues
    // `POST <base>/chat/completions` with a Bearer token, and
    // `npm: "@ai-sdk/anthropic"` issues `POST <base>/messages` with
    // `x-api-key` + `anthropic-version`. Both base URLs must carry their own
    // `/v1` — for anthropic-messages that is the OPPOSITE of Claude Code's
    // convention (Claude appends `/v1/messages`, OpenCode only `/messages`),
    // so the adapter appends `/v1` to catalogue A_MSG endpoints when it
    // writes the provider block. Order is preference: chat-completions first
    // (OpenCode's dominant native path; reasoning delivery fully verified).
    styles: ["openai-chat-completions", "anthropic-messages"],
    spawn: {
      credential: {
        // The adapter writes a per-turn provider block whose `apiKey` is
        // `{env:OPENCODE_PROVIDER_API_KEY}` — a ShipIt-chosen variable, so
        // one delivery works for every service. Deliberately NO `account`
        // target (docs/268 req 5): the eligibility join then structurally
        // excludes every `via: "account"` mode (Anthropic OAuth, ChatGPT) —
        // upstream removed Anthropic subscription login, and ShipIt's
        // ChatGPT/Copilot OAuth wiring for OpenCode is follow-up work.
        string: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
        account: undefined,
      },
      // `opencode run --model shipit/<modelId>` — the adapter always routes
      // through its own `shipit` provider block, never OpenCode's built-in
      // registry, so the flag value is `shipit/<modelId>` (docs/268 plan.md,
      // "serviceId → provider/model").
      model: { kind: "flag", flag: "--model" },
      // The base URL lives in the per-turn config file's provider block; the
      // CLI has no endpoint env var or flag.
      endpoint: { kind: "config-file", path: "opencode.json", pointer: "/provider/shipit/options/baseURL" },
    },
    capabilities: {
      // `-s <sessionID>` verified live (docs/268 Phase 0): recall across
      // processes.
      supportsResume: true,
      // Honest per docs/268 req 6: `-f` exists but an image turn was never
      // OBSERVED (no vision model reachable in the verification container),
      // and a wrong true surfaces as broken attachments at runtime. Flip after
      // a live probe.
      supportsImages: false,
      // Config `instructions` array — the adapter points it at the rendered
      // system-prompt file.
      supportsSystemPrompt: true,
      // Headless runs are `--auto` (full auto inside the container sandbox);
      // no brokered permission gate at launch.
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: [...OPENCODE_TOOL_NAMES],
      // `opencode run --variant <level>` — per-model named variants sourced
      // from models.dev. Observed vocabulary across Anthropic/OpenAI/DeepSeek
      // entries (docs/268 plan.md): none…max; an unknown variant is SILENTLY
      // ignored (verified: `--variant totally-bogus` exits 0), so this list —
      // not the CLI — is the validation. The adapter writes a `variants` map
      // into its provider block so these levels exist for every model it
      // routes.
      reasoning: {
        label: "Reasoning variant",
        options: [
          { value: "none", label: "None" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
      // No chat-native review flow wired for this backend yet.
      supportsReview: false,
      // One-shot spawn per turn, prompt as argv — no mid-turn steering
      // channel.
      supportsSteering: false,
      // The process exits at turn end; it cannot start a turn ShipIt never
      // asked for.
      startsOwnTurns: false,
      // Autocompact exists upstream, but `opencode run` has no on-demand
      // compaction trigger, so the `/compact` composer path cannot work.
      supportsCompaction: false,
      skillsDirName: ".opencode",
      skillInvocationPrefix: "/",
    },
  },
  {
    // docs/274 — the fourth harness. Grok Build imitates Claude Code's flag
    // surface closely enough that the adapter is the Claude shape (spawn per
    // turn, NDJSON on stdout), which is what made this integration small.
    id: "grok",
    name: "Grok Build",
    binary: "grok",
    // xAI is a real native service for this CLI — but note it carries no
    // account machinery either (no ShipIt-side login flow, no OAuth heal), the
    // same caveat OpenCode's row spells out above. Grok's subscription is real
    // and reached by the CLI's OWN `grok login --device-auth`; wiring it is
    // planning#435, and until then `nativeService` here means "whose models
    // and whose bill", not "whose account system".
    nativeService: "xai",
    // VERIFIED (docs/274 Phase 0, CLI 1.0.1, against a local HTTP recorder).
    // ONE CLI, TWO styles: an explicit `-m` turn goes to
    // `POST <base>/chat/completions` with `stream_options: {include_usage}`,
    // while the session-title side-call rides `POST <base>/responses`. The
    // adapter always passes `-m`, so chat-completions is the path a turn
    // actually takes and is listed first; `openai-responses` is here because
    // dropping it would make the catalogue claim an endpoint the CLI reaches
    // is unreachable. Neither base URL takes a suffix from the CLI, so xAI's
    // endpoints carry their own `/v1`.
    styles: ["openai-chat-completions", "openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "XAI_API_KEY" },
        // Deliberately NO `account` target (docs/274 req 6), the docs/268
        // precedent: the eligibility join then structurally excludes every
        // `via: "account"` mode, so no subscription can be selected for a
        // harness whose subscription path is unverified. Flipping this on is
        // planning#435's first line, not a config change.
        account: undefined,
      },
      // `grok -p … -m <modelId>`. Verified forwarded verbatim: the id also
      // appears in an `x-grok-model-override` request header.
      model: { kind: "flag", flag: "-m" },
      endpoint: { kind: "env", name: "GROK_XAI_API_BASE_URL" },
    },
    capabilities: {
      // Verified live: `-r <id>` re-inits with the SAME session_id and recalls
      // the previous turn's facts. ShipIt additionally PRE-ASSIGNS the id with
      // `-s <uuid>` on the first turn rather than parsing one out.
      supportsResume: true,
      // VERIFIED false, not assumed (docs/274 req 7). `--prompt-json` accepts
      // an ACP image content block without complaint, so the syntactic surface
      // exists — but with the image data present ONLY inside the prompt (never
      // written to disk) and a randomized colour pair, grok-4.6 answered
      // "unknown unknown" in a single turn. The block is accepted and its
      // content does not reach the model as vision.
      //
      // The probe is recorded because the FIRST two attempts appeared to
      // succeed and were wrong: the model had reached the answer off the
      // filesystem, which a no-image negative control exposed by answering
      // identically. `image_gen`/`image_edit` in the tool list are OUTPUT
      // tools and say nothing about input.
      supportsImages: false,
      // `--system-prompt-override` replaces the prompt, `--rules` appends.
      supportsSystemPrompt: true,
      supportsPermissionModes: true,
      supportedPermissionModes: GROK_PERMISSION_MODES,
      toolNames: [...GROK_TOOL_NAMES],
      // EMPTY, and honest (docs/274 req 8). `--reasoning-effort` exists in the
      // CLI's help and the binary carries per-model `reasoning_efforts`
      // machinery — but in API-key mode the flag is SILENTLY DROPPED for every
      // model probed (recorder-verified: no effort field reaches the wire).
      // Reasoning in key mode is a model-id choice instead, which is why the
      // 4.20 pair ships as two catalogue rows. Declaring a level ShipIt cannot
      // deliver would put a control on screen that does nothing. The effort
      // machinery appears gated on the subscription catalog; re-probe under
      // planning#435. This is the first harness with no levels, which is why
      // `reviewer-model.ts` had to learn the case (docs/274 req 8).
      reasoning: { label: "Reasoning", options: [] },
      // Unexercised as a reviewer at launch.
      supportsReview: false,
      // One-shot spawn per turn, prompt as argv — no mid-turn steering channel.
      supportsSteering: false,
      // The process exits at turn end; it cannot start a turn ShipIt never
      // asked for.
      startsOwnTurns: false,
      // Autocompact is config-driven only; no on-demand trigger found, so the
      // `/compact` composer path cannot work.
      supportsCompaction: false,
      // Verified live (docs/209 probe): Grok auto-discloses skills from BOTH
      // `.grok/skills/` and `.claude/skills/` via its claude-compat layer, so
      // no symlink is needed — but its OWN directory is the one to declare.
      skillsDirName: ".grok",
      skillInvocationPrefix: "/",
    },
  },
] as const satisfies readonly HarnessDef[];

/**
 * There is deliberately **no model-switching capability flag**. Req 4's "as far
 * as that harness supports it" is currently carried by nothing because both
 * shipped harnesses support it unconditionally — the model is per-turn data for
 * each. A capability with one possible value is noise; `AgentCapabilities` gains
 * the flag if and when a candidate turns up that fixes its model at process start.
 */
export type ShippedHarness = (typeof HARNESSES)[number];
