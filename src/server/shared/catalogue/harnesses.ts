/**
 * docs/252 phase 1 — the harnesses ShipIt can run.
 *
 * A harness is an agent CLI plus the adapter that normalizes its event stream.
 * The set is ShipIt's, not a user's (req 14); which harnesses an *install* has
 * becomes a build input in phase 9.
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
    // 🔍 UNVERIFIED. The repo proves ShipIt drives a *local* `claude` binary; it
    // cannot show what wire format that binary speaks to an endpoint ShipIt has
    // never pointed it at. Phase 3 establishes this empirically — it is the
    // first thing that phase should check, since the whole join rests on it.
    styles: ["anthropic-messages"],
    spawn: {
      credential: {
        // `ANTHROPIC_API_KEY`, not `ANTHROPIC_AUTH_TOKEN`: the repo distinguishes
        // them as two different reserved routes (`claude-api-key` vs
        // `claude-env-oauth`) and `setApiKey()` writes the former.
        string: { kind: "env", name: "ANTHROPIC_API_KEY" },
        account: { kind: "scoped-home" },
      },
      model: { kind: "flag", flag: "--model" },
      // 🔍 No base-URL seam exists in the adapter today; phase 3 writes it.
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
    // 🔍 UNVERIFIED, and Codex is the case in point: ShipIt speaks JSON-RPC to
    // `codex app-server`, which says nothing about whether an arbitrary provider
    // gets driven through the Responses API.
    styles: ["openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "OPENAI_API_KEY" },
        account: { kind: "scoped-home" },
      },
      model: { kind: "turn-payload", field: "model" },
      // 🔍 No provider config is written today; phase 3 writes this seam.
      endpoint: { kind: "config", key: "model_provider.base_url" },
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
