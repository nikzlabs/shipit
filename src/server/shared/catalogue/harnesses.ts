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
 * What is NOT here: Cursor CLI and Grok Build. The survey in
 * `docs/252-custom-models/catalogue.md` records what they appear to need — and
 * already paid for itself by making `styles` a set and giving `SpawnShape` a
 * config-file variant — but neither is a harness ShipIt runs, neither has an
 * honest `capabilities` block to declare, and req 14 governs what an install
 * actually has. OpenCode graduated from that survey to a row via
 * `docs/268-opencode-harness` (empirical findings in its plan.md).
 */

import { CLAUDE_PERMISSION_MODES } from "../types/agent-types.js";
import { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "../agent-tool-names.js";
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
    // Deliberately no `nativeService` (explicit `undefined` so the union
    // keeps the property accessible): OpenCode's own gateway (OpenCode Zen)
    // is a real service that would need honest ServiceDef rows — follow-up,
    // not part of docs/268.
    nativeService: undefined,
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
] as const satisfies readonly HarnessDef[];

/**
 * There is deliberately **no model-switching capability flag**. Req 4's "as far
 * as that harness supports it" is currently carried by nothing because both
 * shipped harnesses support it unconditionally — the model is per-turn data for
 * each. A capability with one possible value is noise; `AgentCapabilities` gains
 * the flag if and when a candidate turns up that fixes its model at process start.
 */
export type ShippedHarness = (typeof HARNESSES)[number];
