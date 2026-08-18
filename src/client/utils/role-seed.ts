/**
 * docs/272-user-selectable-roles req 15 — **when the user picks a role, the browser's own
 * seeds become the role's.**
 *
 * The three composer pickers display a *seed* whenever there is no active
 * session to describe (`seedFromHistory`), which is exactly the state
 * `/{repo}/new` and Quick Capture are in. Without this, choosing a role and then
 * asking for "Adjust parameters…" showed whatever the seeds happened to hold —
 * the harness and model of some earlier session — while the session the role
 * created would run something else entirely. The controls req 15 promises to
 * bring back would have been showing the wrong values.
 *
 * Writing the seeds makes one set of numbers true everywhere: the pickers, the
 * connect params, and the session the role starts. It is also a second path to
 * the same result — a session started while `?role=` could not be applied still
 * runs the role's parameters, because the seeds now carry them.
 *
 * **The values come from the server's own resolution** (`RoleView.resolved`),
 * never from the stored params: which harness can run which model and which
 * level it declares are catalogue rules, and re-deriving them in the browser is
 * the second implementation docs/264 kept out of it. A role that cannot run
 * carries no `resolved`, and nothing is written — it could not have been
 * selected either.
 *
 * Not undone on leaving a role, deliberately: a role is a starting point (req 3),
 * so stepping off it does not restore what the seeds held beforehand, any more
 * than changing the model by hand restores the previous one.
 */

import {
  getSavedAgentId,
  getSavedModelSelection,
  getSavedReasoning,
  saveAgentId,
  saveModelSelection,
  saveReasoning,
} from "./local-storage.js";
import type { RoleView } from "../../server/shared/types/agent-types.js";

/**
 * Write the role's parameters into the three seed slots. Returns whether
 * anything actually changed.
 *
 * **The return value is what makes this safe to call on every render pass**, and
 * it has to be: the seeds also need correcting when a role arrives from the slot
 * on page load rather than from a click, and the caller for that is an effect.
 * Reporting "nothing moved" is what stops the write → re-render → write loop
 * that a bare `void` return would create.
 */
export function applyRoleSeeds(role: RoleView | undefined): boolean {
  const resolved = role?.resolved;
  if (!resolved) return false;
  const selection = {
    serviceId: resolved.serviceId,
    billingMode: resolved.billingMode,
    modelId: resolved.modelId,
  };
  const current = getSavedModelSelection();
  const unchanged =
    getSavedAgentId() === resolved.harnessId
    && current?.serviceId === selection.serviceId
    && current?.billingMode === selection.billingMode
    && current?.modelId === selection.modelId
    && getSavedReasoning(resolved.harnessId) === (resolved.reasoningEffort ?? null);
  if (unchanged) return false;
  saveAgentId(resolved.harnessId);
  saveModelSelection(selection);
  // Per-agent, like the picker's own writes: a level means something different
  // on each harness, so it is stored against the one the role names.
  // `null` — not `undefined` — is this store's "no level", and a harness that
  // declares none resolves to exactly that (docs/274).
  saveReasoning(resolved.harnessId, resolved.reasoningEffort ?? null);
  return true;
}
