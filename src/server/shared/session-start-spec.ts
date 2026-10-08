import { normalizeCapabilities } from "./types.js";
import type { PermissionMode, SessionStartParams, SessionStartSpec, SessionStartTarget } from "./types.js";

/** As for Quick Capture's prompt. */
export const MAX_START_PROMPT_CHARS = 50_000;

const PERMISSION_MODES: readonly PermissionMode[] = ["plan", "guarded", "auto"];

/** Undefined means the value has the wrong shape. */
type ParamReader<K extends keyof SessionStartParams> = (value: unknown) => SessionStartParams[K] | undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

/**
 * How a stored or sent spec reads each parameter (docs/324-scheduled-sessions req 5): a key
 * added to `SessionStartParams` does not compile until it can be read here.
 */
const PARAM_READERS: { [K in keyof SessionStartParams]-?: ParamReader<K> } = {
  role: text,
  // A harness id is checked against the catalogue where the spec is used.
  agent: text as ParamReader<"agent">,
  model: text,
  serviceId: text,
  billingMode: (value) => (value === "sub" || value === "key" ? value : undefined),
  reasoning: text,
  permissionMode: (value) => PERMISSION_MODES.find((mode) => mode === value),
  networkMode: (value) => (value === null || typeof value === "boolean" ? value : undefined),
  sshHosts: (value) =>
    Array.isArray(value) && value.every((id): id is string => typeof id === "string") ? [...new Set(value)] : undefined,
  armAutoMerge: flag,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTarget(value: unknown): SessionStartTarget | string {
  if (isRecord(value)) {
    if (value.kind === "repo") {
      const repoUrl = text(value.repoUrl);
      if (repoUrl) return { kind: "repo", repoUrl };
    }
    if (value.kind === "sandbox") return { kind: "sandbox", capabilities: normalizeCapabilities(value.capabilities) };
  }
  return 'The target must be a repository ({ kind: "repo", repoUrl }) or a sandbox ({ kind: "sandbox", capabilities }).';
}

function readParams(value: unknown): SessionStartParams | string {
  if (value === undefined) return {};
  if (!isRecord(value)) return "The session-start parameters must be an object.";
  const params: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    if (!(key in PARAM_READERS)) return `Unknown session-start parameter "${key}".`;
    const read = (PARAM_READERS as Record<string, (v: unknown) => unknown>)[key](raw);
    if (read === undefined) return `The session-start parameter "${key}" has a value it cannot take.`;
    params[key] = read;
  }
  return params;
}

/** The shape of a session-start description; what its values name is checked where it is used. */
export function parseSessionStartSpec(value: unknown): { spec: SessionStartSpec } | { problem: string } {
  if (!isRecord(value)) return { problem: "The session-start description must be an object." };
  const target = readTarget(value.target);
  if (typeof target === "string") return { problem: target };
  const params = readParams(value.params);
  if (typeof params === "string") return { problem: params };
  if (typeof value.prompt !== "string" || !value.prompt.trim()) return { problem: "The prompt is empty." };
  const prompt = value.prompt.trim();
  if (prompt.length > MAX_START_PROMPT_CHARS) {
    return { problem: `The prompt is longer than ${MAX_START_PROMPT_CHARS.toLocaleString("en-US")} characters.` };
  }
  return { spec: { target, params, prompt } };
}
