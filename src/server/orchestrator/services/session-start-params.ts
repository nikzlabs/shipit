import type { AgentId, PermissionMode, SessionStartParams } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { ReconcileEgressOutcome } from "./reconcile-session-egress.js";
import { toggleAutoMerge } from "./github.js";
import { ServiceError } from "./types.js";
import { getErrorMessage } from "../validation.js";

type StartParamValue<K extends keyof SessionStartParams> = Exclude<SessionStartParams[K], undefined>;

/** The choices resolved together into one harness, model and reasoning level. */
export type StartSelection = Pick<
  SessionStartParams,
  "role" | "agent" | "model" | "serviceId" | "billingMode" | "reasoning"
>;

export interface FirstDispatchParams {
  permissionMode?: PermissionMode;
}

export interface StartParamDeps {
  sessionManager: SessionManager;
  credentialStore: CredentialStore | undefined;
  autoMergeDeps?: {
    githubAuthManager: GitHubAuthManager;
    prStatusPoller: PrStatusPoller | undefined;
  };
  egressDeps?: {
    store: EgressAllowlistStore;
    reconcile: (
      sessionId: string,
      opts?: { agentSeed?: AgentId },
    ) => Promise<ReconcileEgressOutcome>;
  };
  /** Applies a changed SSH grant to a container that is already running. */
  reloadEgress?: (sessionId: string) => Promise<unknown>;
}

export interface StartSessionContext {
  sessionId: string;
  agentId: AgentId;
  deps: StartParamDeps;
}

/**
 * Where one session-start parameter takes effect, in start order: `selection` keys are
 * resolved together before anything is created; `session` keys apply after the session
 * exists and before its runner starts the container; `ready` keys apply once the container
 * runs; `dispatch` keys ride the first turn; `started` keys apply after it.
 */
export type StartParamApplier<K extends keyof SessionStartParams> =
  | { phase: "selection"; apply: (value: StartParamValue<K>, selection: StartSelection) => void }
  | { phase: "session"; apply: (value: StartParamValue<K>, ctx: StartSessionContext) => Promise<void> }
  | { phase: "ready"; apply: (value: StartParamValue<K>, ctx: StartSessionContext) => Promise<void> }
  | { phase: "dispatch"; apply: (value: StartParamValue<K>, fields: FirstDispatchParams) => void }
  | { phase: "started"; apply: (value: StartParamValue<K>, ctx: StartSessionContext) => Promise<void> };

type AsyncPhase = "session" | "ready" | "started";

/** Refuses a destination the registry does not have; run before anything is created. */
export function checkSshHosts(ids: string[] | undefined, deps: StartParamDeps): void {
  if (!ids?.length) return;
  const known = new Set(deps.credentialStore?.listSshHosts().map((h) => h.id) ?? []);
  if (ids.some((id) => !known.has(id))) {
    throw new ServiceError(400, "One or more SSH destinations do not exist");
  }
}

// The container may predate the grant (a claimed workspace's standby), so the firewall is updated live.
async function applySshHosts(ids: string[], { sessionId, deps }: StartSessionContext): Promise<void> {
  deps.sessionManager.setSshHosts(sessionId, ids);
  try {
    await deps.reloadEgress?.(sessionId);
  } catch (err) {
    throw new ServiceError(
      503,
      `Couldn't open this session's SSH destinations in its firewall: ${getErrorMessage(err)}`,
    );
  }
}

async function applyNetworkMode(
  mode: boolean | null,
  { sessionId, agentId, deps }: StartSessionContext,
): Promise<void> {
  if (mode === null || !deps.egressDeps) return;
  deps.egressDeps.store.setSessionOverride(sessionId, mode);
  // Seed the selected agent because it is not persisted yet.
  const outcome = await deps.egressDeps.reconcile(sessionId, { agentSeed: agentId });
  if (outcome.action === "aborted") throw new ServiceError(503, outcome.message);
}

async function armAutoMerge(on: boolean, { sessionId, deps }: StartSessionContext): Promise<void> {
  if (!on || !deps.autoMergeDeps?.prStatusPoller) return;
  try {
    await toggleAutoMerge(deps.autoMergeDeps.githubAuthManager, deps.autoMergeDeps.prStatusPoller, sessionId, true);
  } catch (err) {
    console.warn(`[headless-session] Failed to arm auto-merge for ${sessionId}:`, err);
  }
}

/** How a session start applies each parameter (docs/324-scheduled-sessions req 5). */
export const START_PARAM_APPLIERS: { [K in keyof SessionStartParams]-?: StartParamApplier<K> } = {
  role: { phase: "selection", apply: (name, s) => { s.role = name; } },
  agent: { phase: "selection", apply: (id, s) => { s.agent = id; } },
  model: { phase: "selection", apply: (id, s) => { s.model = id; } },
  serviceId: { phase: "selection", apply: (id, s) => { s.serviceId = id; } },
  billingMode: { phase: "selection", apply: (mode, s) => { s.billingMode = mode; } },
  reasoning: { phase: "selection", apply: (level, s) => { s.reasoning = level; } },
  permissionMode: { phase: "dispatch", apply: (mode, fields) => { fields.permissionMode = mode; } },
  networkMode: { phase: "session", apply: applyNetworkMode },
  sshHosts: { phase: "ready", apply: applySshHosts },
  armAutoMerge: { phase: "started", apply: armAutoMerge },
};

// Each entry's value type matches its key; a loop over the keys cannot express that.
interface LooseApplier {
  phase: StartParamApplier<keyof SessionStartParams>["phase"];
  apply: (value: unknown, target: unknown) => unknown;
}

function definedParams(
  params: SessionStartParams,
  phase: LooseApplier["phase"],
): { applier: LooseApplier; value: unknown }[] {
  const appliers = START_PARAM_APPLIERS as Record<keyof SessionStartParams, LooseApplier>;
  const isSet = (value: unknown): boolean =>
    value !== undefined && !(Array.isArray(value) && value.length === 0);
  return (Object.keys(appliers) as (keyof SessionStartParams)[])
    .filter((key) => isSet(params[key]) && appliers[key].phase === phase)
    .map((key) => ({ applier: appliers[key], value: params[key] }));
}

export function hasStartParams(params: SessionStartParams, phase: AsyncPhase): boolean {
  return definedParams(params, phase).length > 0;
}

export function startSelection(params: SessionStartParams): StartSelection {
  const selection: StartSelection = {};
  for (const { applier, value } of definedParams(params, "selection")) applier.apply(value, selection);
  return selection;
}

export function firstDispatchParams(params: SessionStartParams): FirstDispatchParams {
  const fields: FirstDispatchParams = {};
  for (const { applier, value } of definedParams(params, "dispatch")) applier.apply(value, fields);
  return fields;
}

export async function applyStartParams(
  phase: AsyncPhase,
  params: SessionStartParams,
  ctx: StartSessionContext,
): Promise<void> {
  for (const { applier, value } of definedParams(params, phase)) await applier.apply(value, ctx);
}
