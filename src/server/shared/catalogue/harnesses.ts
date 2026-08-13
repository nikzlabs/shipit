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
 * What is NOT here: Cursor CLI and OpenCode. The survey in
 * `docs/252-custom-models/catalogue.md` records what they appear to need — and
 * already paid for itself by making `styles` a set and giving `SpawnShape` a
 * config-file variant — but neither is a harness ShipIt runs, neither has an
 * honest `capabilities` block to declare, and req 14 governs what an install
 * actually has.
 */

import { CLAUDE_PERMISSION_MODES } from "../types/agent-types.js";
import { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES } from "../agent-tool-names.js";
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
] as const satisfies readonly HarnessDef[];

/**
 * There is deliberately **no model-switching capability flag**. Req 4's "as far
 * as that harness supports it" is currently carried by nothing because both
 * shipped harnesses support it unconditionally — the model is per-turn data for
 * each. A capability with one possible value is noise; `AgentCapabilities` gains
 * the flag if and when a candidate turns up that fixes its model at process start.
 */
export type ShippedHarness = (typeof HARNESSES)[number];
