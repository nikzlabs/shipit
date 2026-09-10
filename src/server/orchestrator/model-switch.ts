import type { AgentInfo, EligibleModel } from "../shared/agent-registry.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import { selectionExists, selectionHonoursEffort } from "../shared/catalogue/index.js";

export interface SelectionSource {
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
}

export function selectionFrom(session: SelectionSource | undefined): ModelSelection | undefined {
  if (!session?.model || !session.serviceId || !session.billingMode) return undefined;
  return {
    serviceId: session.serviceId,
    billingMode: session.billingMode,
    modelId: session.model,
  };
}

export function isEligibleOnAgent(
  agent: Pick<AgentInfo, "eligibleModels"> | undefined,
  selection: ModelSelection | undefined,
): boolean {
  if (!agent || !selection) return false;
  return agent.eligibleModels.some(
    (m) =>
      m.serviceId === selection.serviceId
      && m.billingMode === selection.billingMode
      && m.modelId === selection.modelId,
  );
}

export function selectionOfEntry(entry: EligibleModel): ModelSelection {
  return {
    serviceId: entry.serviceId,
    billingMode: entry.billingMode,
    modelId: entry.modelId,
  };
}

export type ExplicitSelectionVerdict =
  | { ok: true; selection: ModelSelection }
  | { ok: false; message: string };

const INCOHERENT = Symbol("incoherent-selection");

// A partial selection must not fall back to bare-id resolution on a different billed service.
export function modelSelectionFrom(
  modelId: string,
  serviceId: string | undefined,
  billingMode: BillingMode | undefined,
): ModelSelection | typeof INCOHERENT | undefined {
  if (serviceId && billingMode) return { serviceId, billingMode, modelId };
  if (serviceId || billingMode) return INCOHERENT;
  return undefined;
}

export function verifyExplicitSelection(
  agent: Pick<AgentInfo, "name" | "eligibleModels"> | undefined,
  selection: ModelSelection | typeof INCOHERENT | undefined,
): ExplicitSelectionVerdict | undefined {
  if (selection === undefined) return undefined;
  if (selection === INCOHERENT) {
    return {
      ok: false,
      message: "That model selection is incomplete — reload the page and pick again.",
    };
  }
  if (!selectionExists(selection)) {
    return {
      ok: false,
      message:
        `ShipIt has no "${selection.modelId}" on ${selection.serviceId}. `
        + "Reload the page — this list is out of date.",
    };
  }
  if (!isEligibleOnAgent(agent, selection)) {
    return {
      ok: false,
      message:
        `${selection.modelId} on ${selection.serviceId} has no credential `
        + `${agent?.name ?? "this harness"} can use. `
        + "Add one in Settings → Services, or pick another model.",
    };
  }
  return { ok: true, selection };
}

export interface SelectionMove {
  selection?: ModelSelection;
  modelMoved: boolean;
  serviceMoved: boolean;
  reasoningCleared: boolean;
}

export function conformSelectionToAgent(args: {
  agent: Pick<AgentInfo, "id" | "eligibleModels" | "capabilities">;
  current: ModelSelection | undefined;
  currentModelId?: string | undefined;
  currentReasoning: string | undefined;
}): SelectionMove {
  const { agent, current, currentModelId, currentReasoning } = args;
  const clearsOn = (landing: ModelSelection | undefined): boolean => {
    if (!currentReasoning) return false;
    // A declared effort level may still be ignored by the destination model and billing mode.
    if (!agent.capabilities.reasoning?.options.some((o) => o.value === currentReasoning)) return true;
    if (!landing) return false;
    return !selectionHonoursEffort(agent.id, landing, currentReasoning);
  };
  const unchanged: SelectionMove = {
    modelMoved: false,
    serviceMoved: false,
    reasoningCleared: clearsOn(current),
  };

  const keeps = current
    ? isEligibleOnAgent(agent, current)
    : currentModelId === undefined
      ? true
      : agent.eligibleModels.some((m) => m.modelId === currentModelId);
  if (keeps) return unchanged;
  const fallback = agent.eligibleModels[0];
  if (!fallback) return unchanged;

  const selection = selectionOfEntry(fallback);
  return {
    selection,
    modelMoved: selection.modelId !== (current?.modelId ?? currentModelId),
    serviceMoved:
      !!current
      && (selection.serviceId !== current.serviceId
        || selection.billingMode !== current.billingMode),
    reasoningCleared: clearsOn(selection),
  };
}

export function describeGroup(serviceName: string, billingMode: BillingMode): string {
  return `${serviceName} ${billingMode === "sub" ? "subscription" : "API key"}`;
}

export function describeSelectionMove(args: {
  agentName: string;
  move: SelectionMove;
  movedTo?: { label: string; serviceName: string; billingMode: BillingMode };
}): string | undefined {
  const { agentName, move, movedTo } = args;
  const parts: string[] = [];
  if ((move.modelMoved || move.serviceMoved) && movedTo) {
    parts.push(
      `moved to ${movedTo.label} on ${describeGroup(movedTo.serviceName, movedTo.billingMode)}`,
    );
  }
  if (move.reasoningCleared) parts.push("reset the reasoning effort to its default");
  if (parts.length === 0) return undefined;
  return `${agentName} ${parts.join(" and ")}.`;
}
