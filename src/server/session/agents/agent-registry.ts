/**
 * AgentRegistry — re-exports from shared.
 *
 * The canonical implementation lives in shared/agent-registry.ts.
 * This file re-exports for backwards compatibility with existing imports.
 */

export { AgentRegistry, ALLOWED_ENV_KEYS } from "../../shared/agent-registry.js";
export type { AgentInfo } from "../../shared/agent-registry.js";
