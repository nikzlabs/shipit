/**
 * AgentProcess — re-exports from shared types.
 *
 * The canonical definitions live in shared/types/agent-types.ts.
 * This file re-exports them so existing session-layer imports continue to work.
 */

export type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentInitEvent,
  AgentAssistantEvent,
  AgentToolResultEvent,
  AgentResultEvent,
  AgentContentBlock,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "../../shared/types/agent-types.js";

export type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpServerState,
  McpServerStatus,
  McpTool,
  McpTestResult,
} from "../../shared/types/mcp-types.js";
