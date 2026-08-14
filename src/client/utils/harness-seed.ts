import {
  clearParkedHarness,
  getSavedModelId,
  getSavedModelSelection,
  saveAgentId,
  saveModelId,
  saveModelSelection,
} from "./local-storage.js";
import { modelRowsFor } from "./model-rows.js";
import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption, ModelChoice } from "../agent-types.js";

/**
 * **A harness pick has to move the model seed, or it is not a pick.**
 *
 * The harness a new session is created on is derived FROM the saved model
 * (`newSessionAgentId`, docs/142: the model is the single source of truth). So a
 * control that writes only `vibe-agent-id` is outvoted by the unchanged
 * `vibe-model-id` the moment anything re-derives — and `useUiStore.reset()`
 * re-derives on every new session and every session switch. The pick survives
 * exactly as long as the page stays put, which is why the failure reads as "the
 * dropdown switched back on its own" rather than as a dropdown that never
 * worked.
 *
 * docs/166 fixed this for Quick Capture, whose creation params carry the model
 * directly. The composer looked exempt — it sends `set_agent`, and the server
 * re-resolves THAT SESSION's model (`conformSelectionToAgent`) — but the server
 * never touches the browser's global seed, so the next session derived the old
 * harness again. One rule now serves both, because a third copy is how the two
 * would drift apart on exactly the models this exists for.
 *
 * The in-session half is deliberately NOT duplicated here: `set_agent` remains
 * the only thing that moves a live session's model, so the server stays the sole
 * authority on what a session runs. This moves the SEED — the answer to "what
 * will the next session be created on".
 */

/** What the caller is on now, as much of it as it knows. */
export interface CurrentSeed {
  modelId?: string;
  serviceId?: string;
  billingMode?: "sub" | "key";
}

/**
 * The row a harness switch should land on: **the same model wherever the new
 * harness offers it**, and its first row only when it does not.
 *
 * A harness switch is not a model switch. The models that make this matter are
 * precisely the ones both harnesses run — DeepSeek, GLM, anything through a
 * gateway — so dropping to `rows[0]` whenever the harness changes would change
 * the model in the one case the user is least expecting it to.
 *
 * The same `(service, billing mode)` is preferred over the same id elsewhere, so
 * the switch cannot silently re-bill an identical id through another service
 * (docs/252 req 11). `rows[0]` is the last resort and is what the model picker
 * itself falls back to, so the trigger, the menu and the created session agree.
 */
export function modelRowAfterHarnessPick(
  rows: ModelChoice[],
  current: CurrentSeed | undefined,
): ModelChoice | undefined {
  const modelId = current?.modelId;
  if (modelId) {
    const sameGroup = rows.find(
      (r) =>
        r.modelId === modelId
        && r.serviceId === current?.serviceId
        && r.billingMode === current?.billingMode,
    );
    if (sameGroup) return sameGroup;
    const sameModel = rows.find((r) => r.modelId === modelId);
    if (sameModel) return sameModel;
  }
  return rows[0];
}

/**
 * Persist a deliberate harness pick: the harness AND the model seed that has to
 * agree with it. Returns the model id now seeded, or `undefined` when the
 * harness offers no row to seed (its auth gate should have refused the pick).
 *
 * Clears the parked selection, because this is the user speaking: a pick made
 * while their usual harness is unreachable must not be undone when it comes back
 * (see `ParkedHarness` in `local-storage.ts`).
 */
export function persistHarnessPick(opts: {
  agentId: AgentId;
  agents: AgentOption[];
  /**
   * What to keep if the new harness can run it. Defaults to the saved seed —
   * pass the live session model when the composer is showing one, so the switch
   * keeps what the user is looking at rather than what the slot happens to hold,
   * or the parked triple when handing a redirected selection back.
   */
  current?: CurrentSeed;
}): string | undefined {
  const { agentId, agents } = opts;
  const saved = getSavedModelSelection();
  const modelId = opts.current?.modelId ?? getSavedModelId();
  // The saved `(service, billing mode)` is inherited only when it describes the
  // SAME model. A caller that knows only the id — the composer, reading the live
  // session model — must not have the slot's service attached to a model it was
  // never about, or "prefer the same group" would prefer a group the model is
  // not in and quietly skip to `rows[0]`.
  const group =
    opts.current?.serviceId !== undefined
      ? { serviceId: opts.current.serviceId, billingMode: opts.current.billingMode }
      : saved && saved.modelId === modelId
        ? { serviceId: saved.serviceId, billingMode: saved.billingMode }
        : {};
  const current: CurrentSeed = { ...(modelId ? { modelId } : {}), ...group };

  saveAgentId(agentId);
  clearParkedHarness();

  const next = modelRowAfterHarnessPick(
    modelRowsFor(agents.find((a) => a.id === agentId)),
    current,
  );
  if (!next) return undefined;
  if (next.serviceId) {
    saveModelSelection({
      serviceId: next.serviceId,
      billingMode: next.billingMode,
      modelId: next.modelId,
    });
  } else {
    saveModelId(next.modelId);
  }
  // `saveModelSelection` REFUSES a triple this build's catalogue cannot place,
  // and refuses it silently. The seed is what the harness is derived from, so a
  // refusal would leave the pick outvoted by the model it failed to write — the
  // very bug this function exists to fix. Fall back to the bare id, which is
  // stored as-is.
  if (getSavedModelId() !== next.modelId) saveModelId(next.modelId);
  return next.modelId;
}
