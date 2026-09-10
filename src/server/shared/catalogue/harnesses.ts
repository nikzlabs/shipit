// Keep installer rows in docker/agent-cli/install-agent-clis.sh in sync.
import { CLAUDE_PERMISSION_MODES, GROK_PERMISSION_MODES } from "../types/agent-types.js";
import { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES, GROK_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "../agent-tool-names.js";
import type { HarnessDef } from "./types.js";

export const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    nativeService: "anthropic",
    // Claude appends /v1/messages; catalogue base URLs omit /v1.
    styles: ["anthropic-messages"],
    spawn: {
      credential: {
        // API_KEY sends x-api-key; AUTH_TOKEN sends Bearer. Services may override this.
        string: { kind: "env", name: "ANTHROPIC_API_KEY" },
        account: { kind: "scoped-home" },
      },
      // The CLI consumes [1m]; the service receives the ID without it.
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
    styles: ["openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "OPENAI_API_KEY" },
        account: { kind: "scoped-home" },
      },
      model: { kind: "turn-payload", field: "model" },
      // Field within a named provider block. Codex appends /responses, so the URL includes /v1.
      endpoint: { kind: "config", key: "base_url" },
    },
    capabilities: {
      supportsResume: true,
      // app-server uses attached image paths, not CLI -i arguments.
      supportsImages: true,
      supportsSystemPrompt: true,
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: [...CODEX_TOOL_NAMES],
      reasoning: {
        label: "Reasoning effort",
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
      supportsReview: true,
      supportsSteering: true,
      // Late assistant events after turn/completed belong to the finished turn.
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
    // Native service does not imply account login support; unshaped spawns cannot authenticate.
    nativeService: "opencode",
    // OpenCode appends /messages; its adapter adds /v1 to Anthropic catalogue URLs.
    styles: ["openai-chat-completions", "anthropic-messages", "openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY", styles: ["openai-chat-completions", "anthropic-messages"] },
        account: { kind: "scoped-home", styles: ["openai-responses"] },
      },
      // String routes use shipit/<modelId>; ChatGPT accounts use openai/<modelId>.
      model: { kind: "flag", flag: "--model" },
      endpoint: { kind: "config-file", path: "opencode.json", pointer: "/provider/shipit/options/baseURL" },
    },
    capabilities: {
      supportsResume: true,
      // Requires image input modalities in the adapter's provider block.
      supportsImages: true,
      supportsSystemPrompt: true,
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: [...OPENCODE_TOOL_NAMES],
      // Unknown variants are silently ignored; the adapter must declare this map.
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
      supportsReview: true,
      supportsSteering: false,
      startsOwnTurns: false,
      // Uses POST /session/{id}/summarize; /compact and --command compact do not work.
      supportsCompaction: true,
      skillsDirName: ".opencode",
      skillInvocationPrefix: "/",
    },
  },
  {
    id: "grok",
    name: "Grok Build",
    binary: "grok",
    nativeService: "xai",
    // Turns use chat/completions; title side-calls use responses. Base URLs include /v1.
    styles: ["openai-chat-completions", "openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "XAI_API_KEY" },
        // Scrub XAI_API_KEY: it overrides the account's auth.json.
        account: { kind: "scoped-home" },
      },
      model: { kind: "flag", flag: "-m" },
      endpoint: { kind: "env", name: "GROK_XAI_API_BASE_URL" },
    },
    capabilities: {
      supportsResume: true,
      // Image blocks were accepted but not delivered as vision in the controlled probe.
      supportsImages: false,
      supportsSystemPrompt: true,
      supportsPermissionModes: true,
      supportedPermissionModes: GROK_PERMISSION_MODES,
      toolNames: [...GROK_TOOL_NAMES],
      // Key-billed turns drop effort; use reasoningOptionsFor to apply this gate.
      reasoning: {
        label: "Reasoning",
        options: [
          { value: "xhigh", label: "Extra high" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        billingModes: ["sub"],
      },
      supportsReview: true,
      supportsSteering: false,
      startsOwnTurns: false,
      // /compact is intercepted. Wire metadata says "auto" even for manual requests.
      supportsCompaction: true,
      skillsDirName: ".grok",
      skillInvocationPrefix: "/",
    },
  },
] as const satisfies readonly HarnessDef[];
