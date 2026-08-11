/**
 * docs/261 phase 6 (reqs 11, 12) — the model list, split the way the controls
 * are: a service you choose, then the models that service offers.
 *
 * Until now both Settings surfaces flattened every eligible model of every
 * service into one menu and grouped it by header. That answers "which model"
 * and leaves "who is paying" as something to read rather than something to
 * choose (req 11), and it is a list that grows with the catalogue (req 12).
 */

import { getModel } from "../../../server/shared/catalogue/index.js";
import type { AgentOption, EligibleModelOption } from "../../agent-types.js";

/** One `(service, billing mode)` pair — the unit a model is selected under. */
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

/** The services those models come from, in catalogue order, each listed once. */
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

/** The models one service offers under one billing mode (req 12's bound). */
export function modelsOfService(
  models: EligibleModelOption[],
  service: { serviceId: string; billingMode: string } | undefined,
): EligibleModelOption[] {
  if (!service) return [];
  const key = serviceKeyOf(service);
  return models.filter((m) => serviceKeyOf(m) === key);
}

/** What a caller can hand to {@link modelAfterServiceChange} as "the model now". */
export interface CurrentModel {
  serviceId: string;
  billingMode: "sub" | "key";
  modelId: string;
  canonicalModelKey?: string;
}

/**
 * The identity of the model a slot holds — from the eligible row when there is
 * one, and **from the catalogue when there is not**.
 *
 * The second half is not belt-and-braces. A pin whose credential went away has
 * no eligible row at all, and that is precisely when a user re-points the slot
 * at a service that survived: without the catalogue lookup, "keep the model"
 * would silently become "take the new service's first model" in the one case
 * where the user is least able to notice. The catalogue is static, so it still
 * knows what the pinned row is; only the credential is gone.
 *
 * This is a LOOKUP of the authored answer, not a second derivation of it — the
 * rule the design rules out is re-deriving identity from an id in the browser,
 * and `getModel` is the catalogue's own function.
 */
export function canonicalKeyOf(current: CurrentModel | undefined): string | undefined {
  if (!current) return undefined;
  return current.canonicalModelKey ?? getModel(current)?.canonicalModelKey;
}

/**
 * The model a slot holds after the user changes its service: **the same model
 * when the new service offers it**, otherwise that service's first.
 *
 * Identity is `canonicalModelKey` — the catalogue's authored answer to "are
 * these the same model" — and NOT the model id. The deciding case is the one
 * docs/252 built the catalogue around: `anthropic/claude-opus-5` through a
 * gateway and `claude-opus-5` direct are two strings and one set of weights, so
 * an id comparison would drop the user's model in exactly the situation this
 * rule exists for — changing only who pays for it.
 */
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
