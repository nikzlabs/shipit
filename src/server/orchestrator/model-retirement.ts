import type { AgentId } from "../shared/types.js";
import {
  nativeServiceForHarness,
  resolveRetiredModelId,
  retirementSuccessor,
  type BillingMode,
  type ModelSelection,
} from "../shared/catalogue/index.js";

export interface RetirementSessionView {
  id: string;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
}

export interface RetirementSessionWriter {
  setModelSelection(id: string, selection: ModelSelection): void;
}

export function applyModelRetirement(
  sessions: RetirementSessionWriter,
  session: RetirementSessionView | null | undefined,
  harnessId: AgentId,
): string | undefined {
  const modelId = session?.model;
  if (!session || !modelId) return modelId;

  const successor =
    session.serviceId && session.billingMode
      ? retirementSuccessor(harnessId, {
          serviceId: session.serviceId,
          billingMode: session.billingMode,
          modelId,
        })
      : resolveRetiredModelId(harnessId, modelId, nativeServiceForHarness(harnessId));
  if (!successor) return modelId;

  // Persist the successor so the picker shows the model that runs.
  try {
    sessions.setModelSelection(session.id, successor);
  } catch (err) {
    // Run the successor even if persistence fails; the retired model may no longer work.
    console.warn(
      `[model-retirement] could not persist ${session.id}: ${modelId} → ${successor.modelId}`,
      err,
    );
    return successor.modelId;
  }
  console.log(
    `[model-retirement] ${session.id} moved ${modelId} → ${successor.modelId} ` +
      `(${successor.serviceId}/${successor.billingMode}, harness ${harnessId})`,
  );
  return successor.modelId;
}
