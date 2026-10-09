import { HARNESSES, catalogueModelLabels, getService } from "./catalogue/index.js";
import type { PermissionMode, SessionStartParams } from "./types.js";

type StartParamValue<K extends keyof SessionStartParams> = Exclude<SessionStartParams[K], undefined>;

/** Names a value cannot carry by itself, such as an SSH destination's label. */
export interface StartParamNames {
  sshHostLabel?: (hostId: string) => string | undefined;
}

export interface StartParamLabel<K extends keyof SessionStartParams> {
  /** What the composer and Session settings call the choice. */
  label: string;
  describe(value: StartParamValue<K>, names?: StartParamNames): string;
}

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: "Plan",
  guarded: "Guarded",
  auto: "Auto",
};

function reasoningLabel(value: string): string {
  for (const harness of HARNESSES) {
    const option = harness.capabilities.reasoning?.options.find((o) => o.value === value);
    if (option) return option.label;
  }
  return value;
}

/** How cards and Settings describe each session-start choice (docs/324-scheduled-sessions req 11). */
export const START_PARAM_LABELS: { [K in keyof SessionStartParams]-?: StartParamLabel<K> } = {
  role: { label: "Role", describe: (name) => name },
  agent: {
    label: "Harness",
    describe: (id) => HARNESSES.find((h) => h.id === id)?.name ?? id,
  },
  model: { label: "Model", describe: (id) => catalogueModelLabels()[id] ?? id },
  serviceId: { label: "Service", describe: (id) => getService(id)?.name ?? id },
  billingMode: {
    label: "Billing",
    describe: (mode) => (mode === "sub" ? "Subscription" : "API key"),
  },
  reasoning: { label: "Reasoning", describe: reasoningLabel },
  permissionMode: { label: "Permission mode", describe: (mode) => PERMISSION_MODE_LABELS[mode] },
  networkMode: {
    label: "Network containment",
    describe: (mode) => (mode === true ? "Contained" : mode === false ? "Open" : "Inherit global"),
  },
  sshHosts: {
    label: "SSH destinations",
    describe: (ids, names) =>
      ids.length === 0 ? "None" : ids.map((id) => names?.sshHostLabel?.(id) ?? id).join(", "),
  },
  armAutoMerge: { label: "Auto-merge when ready", describe: (on) => (on ? "On" : "Off") },
};
