import type { AgentProcess } from "../shared/types/agent-types.js";
import type {
  AgentMcpBridge,
  AgentMcpWriteResult,
  AgentRunParams,
} from "../shared/types/agent-types.js";
import { selectAgentEnvForPush, type AccountAgentEnvSource } from "./session-agent-env.js";
import { localAgentOpsSpawnEnv } from "./local-agent-ops.js";
import { getErrorMessage } from "../shared/utils.js";

// Local mode has no session worker to serve the internal MCP bridge's requests.
export const LOCAL_SHIPIT_BRIDGE: AgentMcpBridge | null = null;

export interface LocalAgentMcpDeps {
  credentialStore: AccountAgentEnvSource;
  sessionId?: string;
  onServerFailed?: (name: string, reason: string) => void;
}

export function localMcpSpawnEnv(
  credentialStore: LocalAgentMcpDeps["credentialStore"],
): Record<string, string> {
  return selectAgentEnvForPush({ serviceManager: null, credentialStore });
}

// The adapter must spawn synchronously, before this restores the environment.
function withTemporaryEnv<T>(values: Record<string, string>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

export function applyLocalMcp(agent: AgentProcess, deps: LocalAgentMcpDeps): AgentProcess {
  const innerRun = agent.run.bind(agent);
  agent.run = (params: AgentRunParams): void => {
    const spawnEnv = {
      ...localMcpSpawnEnv(deps.credentialStore),
      ...(deps.sessionId ? localAgentOpsSpawnEnv(deps.sessionId) : {}),
    };
    // Secrets must be available both when resolving config placeholders and when spawning.
    withTemporaryEnv(spawnEnv, () => {
      let write: AgentMcpWriteResult = {};
      try {
        write = agent.writeMcpConfig({
          servers: params.mcpServers ?? [],
          shipitBridge: LOCAL_SHIPIT_BRIDGE,
          onServerFailed: (name, reason) => {
            console.warn(`[mcp] local spawn dropping server "${name}": ${reason}`);
            deps.onServerFailed?.(name, reason);
          },
        });
      } catch (err) {
        console.warn(
          `[mcp] local MCP config write failed, spawning without MCP: ${getErrorMessage(err)}`,
        );
      }
      withTemporaryEnv(write.runtimeEnv ?? {}, () => {
        innerRun({
          ...params,
          ...(write.mcpConfigPath !== undefined ? { mcpConfigPath: write.mcpConfigPath } : {}),
        });
      });
      // An adapter can run again; use once to avoid retaining per-turn cleanup listeners.
      if (write.cleanup) agent.once("done", write.cleanup);
    });
  };
  return agent;
}
