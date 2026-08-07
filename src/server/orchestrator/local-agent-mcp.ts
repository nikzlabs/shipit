/**
 * MCP for `RUNTIME_MODE=local` spawns (planning#300, docs/118 §dogfood, docs/088).
 *
 * A containerized turn gets MCP through the session **worker**, in two writes
 * that happen in two different processes:
 *
 *   1. **Config** — `McpConfigController.invokeAgentMcpWriter` calls the
 *      adapter's `writeMcpConfig()` immediately before `/agent/start` spawns the
 *      CLI (`session/agent-controller.ts`). That is what produces Claude's
 *      `--mcp-config` JSON and Codex's `config.toml` MCP block.
 *   2. **Credentials** — step 4 of `prepareSessionAgentEnvironment` POSTs the
 *      merged agent-env (`selectAgentEnvForPush`) into the worker's
 *      `process.env`, which is where `writeMcpConfig()` resolves `$secret:` /
 *      `$platform:` placeholders from and where the CLI's MCP children read
 *      their credentials.
 *
 * Local mode has neither. `McpConfigController` is constructed only in
 * `session-worker.ts` and there is no worker, so write 1 never ran; the env push
 * is gated on `runner instanceof ContainerSessionRunner` and there is no
 * container, so write 2 never ran either. The result was not "no browser" but
 * **no MCP at all** — every dogfood turn spawned its CLI with no `--mcp-config`
 * and no MCP secrets.
 *
 * Closing either gate alone is useless (a config with no secrets, or secrets
 * with nothing configured), so both writes live here, applied at the ONE place
 * local mode already reaches for a per-session spawn decision: the spawn itself.
 * That is the same shape planning#284 settled on for the credential gap
 * (`local-agent-home.ts` — HOME resolved per spawn, not provisioned per
 * session), and for the same reason: `prepareSessionAgentEnvironment`'s steps
 * all assume a worker to POST to, so un-gating them would be wrong. See the
 * reconciliation notes in `docs/118-shipit-ui-local/plan.md`.
 *
 * ## What the local agent gets, and what it does not
 *
 * **Does**: the built-in **Playwright** browser server and every
 * **user-configured** MCP server (docs/088), including their `$secret:` /
 * `$platform:` values. Neither needs anything from ShipIt at run time — the
 * browser drives itself and a user server talks to its own provider — so both
 * are fully functional in local mode.
 *
 * **Does not**: the internal `shipit` bridge, hence no `present`, `voice_note`,
 * `propose_actions`, `report_shipit_bug`, or `permission_prompt`. This is NOT an
 * oversight and not a config choice — see {@link LOCAL_SHIPIT_BRIDGE}.
 */

import type { AgentProcess } from "../shared/types/agent-types.js";
import type {
  AgentMcpBridge,
  AgentMcpWriteResult,
  AgentRunParams,
} from "../shared/types/agent-types.js";
import type { CredentialStore } from "./credential-store.js";
import { selectAgentEnvForPush } from "./session-agent-env.js";
import { localAgentOpsSpawnEnv } from "./local-agent-ops.js";
import { getErrorMessage } from "../shared/utils.js";

/**
 * The `shipit` MCP bridge is deliberately absent from a local spawn.
 *
 * Every tool the bridge exposes is a *transport* to the session worker: each
 * one POSTs to `http://127.0.0.1:$WORKER_PORT/agent-ops/…`
 * (`session/mcp-tools/*.ts`), and the worker either serves the request itself
 * (present, permission, ask) or relays it to the orchestrator with the trusted
 * `SESSION_ID` injected (voice, bug, propose_actions). Local mode has no worker
 * and therefore no `/agent-ops` host — nothing listens on that port.
 *
 * The bridge PROCESS would still start (it is repo code, and the dogfood
 * container is the repo), so the server would connect and advertise its tools;
 * every call would then fail with ECONNREFUSED. That is worse than absence in
 * two concrete ways: the agent burns turns on tools that cannot work, and
 * `writeMcpConfig()` would set Claude's `--permission-prompt-tool` to
 * `mcp__shipit__permission_prompt`, so a sensitive-file gate would consult an
 * unreachable broker instead of falling back to the CLI's own handling.
 *
 * Giving local mode these tools means giving it an `/agent-ops` host — the same
 * missing piece that leaves the dogfood image without the `gh` and `shipit`
 * shims (`Dockerfile.dogfood` installs neither). That is a separate mechanism,
 * tracked separately; it is not something this module can decide.
 */
export const LOCAL_SHIPIT_BRIDGE: AgentMcpBridge | null = null;

export interface LocalAgentMcpDeps {
  /** Source of the MCP env — the same store the worker push reads from. */
  credentialStore: Pick<CredentialStore, "getAllAgentEnv" | "getAllMcpOAuthTokens">;
  /**
   * Session whose `/agent-ops` host address should reach the spawn (docs/251).
   * Omit and no `SHIPIT_AGENT_OPS_URL` is set, which is the pre-docs/251
   * behavior: the shims fall back to a worker that isn't there.
   */
  sessionId?: string;
  /**
   * Report a server that had to be dropped (missing secret), mirroring the
   * worker's `mcp_server_status` SSE broadcast. Optional: without it a dropped
   * server is logged and nothing reaches the UI.
   */
  onServerFailed?: (name: string, reason: string) => void;
}

/**
 * The env a local MCP spawn needs.
 *
 * Deliberately the SAME payload the containerized path pushes to the worker —
 * `selectAgentEnvForPush` with no `ServiceManager`, i.e. `getAllAgentEnv()` +
 * `collectMcpAgentEnv()`. A local session is compose-less by construction (local
 * mode runs no Compose stacks), so the compose-less branch is the right one, and
 * reusing the function is what keeps the two modes from drifting on which
 * namespaces an MCP server may reference.
 */
export function localMcpSpawnEnv(
  credentialStore: LocalAgentMcpDeps["credentialStore"],
): Record<string, string> {
  return selectAgentEnvForPush({ serviceManager: null, credentialStore });
}

/**
 * Run `fn` with `values` applied to `process.env`, then restore.
 *
 * Mirrors `AgentController.withTemporaryEnv` in the worker, and relies on the
 * same property: an adapter's `run()` spawns its child **synchronously**, so the
 * child has already captured the env by the time this returns. Nothing else can
 * observe the window — no `await` is crossed while the values are applied.
 */
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

/**
 * Wrap a local-mode adapter's `run()` so the spawn carries MCP config AND MCP
 * credentials — the worker's two writes, performed in-process.
 *
 * Returns the same instance (patched), not a decorator: `AgentProcess` is a wide
 * interface whose surface keeps growing, and a delegating wrapper would silently
 * drop whatever it forgot to forward. Only `run` needs to change.
 *
 * Ordering inside the wrapped `run` is load-bearing and mirrors the worker's:
 *
 *   - the MCP env is applied BEFORE `writeMcpConfig()`, because that is what
 *     `$secret:` / `$platform:` placeholders resolve against;
 *   - it is still applied DURING the spawn, because the CLI's MCP child
 *     processes inherit it (Claude passes its whole env down; Codex allowlists
 *     specific names via `env_vars` and reads their values from the same env);
 *   - `runtimeEnv` (Codex's env-indirection for resolved secrets) is merged in
 *     for the spawn only.
 *
 * Fault-tolerant on purpose: a failed config write logs and spawns WITHOUT MCP
 * rather than killing the turn. The same call throwing in the worker returns a
 * 500 from `/agent/start`, but there the failure is visible as a failed turn
 * with a worker log behind it; here the equivalent would be a dogfood session
 * that cannot run at all because, say, `/tmp` was unwritable.
 */
export function applyLocalMcp(agent: AgentProcess, deps: LocalAgentMcpDeps): AgentProcess {
  const innerRun = agent.run.bind(agent);
  agent.run = (params: AgentRunParams): void => {
    // docs/251 — the `gh` shim's broker address rides the same temporary-env
    // window. Not an MCP value, but this is the one seam a local spawn has for
    // per-session env, and `session-agent-env.ts` has already awaited the host
    // so the lookup is a hit by the time we get here.
    const spawnEnv = {
      ...localMcpSpawnEnv(deps.credentialStore),
      ...(deps.sessionId ? localAgentOpsSpawnEnv(deps.sessionId) : {}),
    };
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
      // Same as the worker: the per-turn config file is unlinked when the
      // process exits. Codex writes a fixed path and returns no cleanup.
      // `once`, not `on` — the worker builds a fresh adapter per turn, but here
      // an adapter is reachable for a second `run()` (a non-resident agent kept
      // on the runner), and a listener per run would leak.
      if (write.cleanup) agent.once("done", write.cleanup);
    });
  };
  return agent;
}
