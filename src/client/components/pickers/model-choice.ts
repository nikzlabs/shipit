

import { getModel } from "../../../server/shared/catalogue/index.js";
import type { AgentOption, EligibleModelOption } from "../../agent-types.js";

export interface ServiceChoice {
  serviceId: string;
  serviceName: string;
  billingMode: "sub" | "key";
}

/**
 * The pair, as one string.
 *
 * A service is never the unit on its own: two modes of one service are two
 * different things to a user asking who pays, and a subscription may offer
 * fewer models than the key does (docs/252 req 5).
 */
export function serviceKeyOf(value: { serviceId: string; billingMode: string }): string {
  return `${value.serviceId}:${value.billingMode}`;
}

/**
 * Every eligible triple across INSTALLED harnesses, de-duplicated.
 *
 * De-duplicated because the harness is derived (req 3): one model offered on
 * both installed harnesses is one choice, not two. Which harness runs it is the
 * server's derivation — for a reviewer it can differ per review, since the
 * ranking prefers a harness that is not the implementer's — so offering the
 * model twice would imply a decision the user does not make.
 */
export function eligibleModelsOf(agents: AgentOption[]): EligibleModelOption[] {
  const seen = new Set<string>();
  const out: EligibleModelOption[] = [];
  for (const agent of agents) {
    if (!agent.installed) continue;
    for (const model of agent.eligibleModels ?? []) {
      const key = `${serviceKeyOf(model)}|${model.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
  }
  return out;
}

export function servicesOf(models: EligibleModelOption[]): ServiceChoice[] {
  const seen = new Set<string>();
  const out: ServiceChoice[] = [];
  for (const model of models) {
    const key = serviceKeyOf(model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      serviceId: model.serviceId,
      serviceName: model.serviceName,
      billingMode: model.billingMode,
    });
  }
  return out;
}

export function modelsOfService(
  models: EligibleModelOption[],
  service: { serviceId: string; billingMode: string } | undefined,
): EligibleModelOption[] {
  if (!service) return [];
  const key = serviceKeyOf(service);
  return models.filter((m) => serviceKeyOf(m) === key);
}

export interface HarnessChoice {
  id: string;
  name: string;
  reasoning: AgentOption["reasoning"];
}

/**
 * docs/264-agent-roles req 6 — **which harnesses can run this model**, on this install.
 *
 * A role names its harness and never derives it, so the editor has to offer the
 * set rather than pick from it. Most models have exactly one member here and the
 * field is a readout; `deepseek-flash` has two (`services.ts` declares all three
 * API styles on it, so both harnesses share it), and there the harness is a real
 * choice only the user can make.
 *
 * **Read from the server's own per-harness eligibility, not re-derived.** Each
 * `AgentOption.eligibleModels` is the credential-filtered join the server
 * computed for that harness, so asking which harnesses list this triple is a
 * lookup in what the server sent — the opposite of reimplementing `resolveStyle`
 * in the browser. The server still validates the save (req 6), which is where a
 * combination this list would allow but the catalogue would not is refused.
 *
 * Empty when the model is not eligible anywhere — the stranded case, where the
 * editor shows the stored harness id as text instead of a control.
 */
export function harnessesForModel(
  agents: AgentOption[],
  model: { serviceId: string; billingMode: string; modelId: string } | undefined,
): HarnessChoice[] {
  if (!model) return [];
  const key = `${serviceKeyOf(model)}|${model.modelId}`;
  return agents
    .filter(
      (agent) =>
        agent.installed
        && (agent.eligibleModels ?? []).some((m) => `${serviceKeyOf(m)}|${m.modelId}` === key),
    )
    .map((agent) => ({ id: agent.id, name: agent.name, reasoning: agent.reasoning }));
}

export interface CurrentModel {
  serviceId: string;
  billingMode: "sub" | "key";
  modelId: string;
  canonicalModelKey?: string;
}

export function canonicalKeyOf(current: CurrentModel | undefined): string | undefined {
  if (!current) return undefined;
  return current.canonicalModelKey ?? getModel(current)?.canonicalModelKey;
}

export function modelAfterServiceChange(
  current: CurrentModel | undefined,
  candidates: EligibleModelOption[],
): EligibleModelOption | undefined {
  const key = canonicalKeyOf(current);
  if (key) {
    const same = candidates.find((m) => m.canonicalModelKey === key);
    if (same) return same;
  }
  return candidates[0];
}
