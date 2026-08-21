/**
 * docs/252 phase 8 — move a session off a model the catalogue has retired.
 *
 * Curation (req 6) means models leave the catalogue on purpose and regularly. A
 * session already pinned to one keeps working: the catalogue records a successor
 * per `(service, billing mode)` and per style, and this is where a session
 * resolves through that record (req 13).
 *
 * **The remap writes through to the stored selection; it is not a read-time
 * normalization.** The shim this generalizes rewrote the model only at the turn
 * boundary and left the row alone, while the picker gives the *persisted* model
 * precedence over the live one the CLI reports — so transcribing that shape
 * would run the successor while displaying the retired id, which is exactly the
 * invisible remap reqs 11 and 13 forbid.
 *
 * Call it wherever the session's model is read for a turn. It is idempotent and
 * cheap: a session on a current model costs two array scans and writes nothing,
 * and after a remap the row is current so the next call is that same no-op.
 */

import type { AgentId } from "../shared/types.js";
import {
  nativeServiceForHarness,
  resolveRetiredModelId,
  retirementSuccessor,
  type BillingMode,
  type ModelSelection,
} from "../shared/catalogue/index.js";

/** The session fields this reads. Narrowed so tests need no full `SessionInfo`. */
export interface RetirementSessionView {
  id: string;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
}

/** The one write this performs — narrowed to keep the dependency honest. */
export interface RetirementSessionWriter {
  setModelSelection(id: string, selection: ModelSelection): void;
}

/**
 * The model id `session` should run, moving it onto its successor and
 * persisting that when the catalogue has retired what it holds.
 *
 * Returns the session's own model unchanged when there is nothing to do — which
 * is every session on a current model, a session whose model the catalogue never
 * carried at all (a versioned slug the picker never surfaced), and a retirement
 * whose successor this harness cannot speak to. That last one is a catalogue
 * mistake rather than a case to fall back from (req 13), so this function moves
 * nothing.
 *
 * **It does not follow that the session stays put.** A model no harness lists is
 * already handled downstream — WS connect replaces it with the harness's first
 * model and persists that — and this function deliberately does not change that
 * pre-existing self-heal, which exists for every unlistable id (aliases,
 * versioned slugs), not for retirement. So a missing successor degrades to
 * today's behaviour rather than to "untouched": the honest statement is that
 * this resolver declines to guess, not that nothing else will.
 *
 * `harnessId` is the session's pinned harness, and it is load-bearing: a
 * successor must be one that harness can run, or the remap strands the session
 * as surely as having no successor at all.
 */
export function applyModelRetirement(
  sessions: RetirementSessionWriter,
  session: RetirementSessionView | null | undefined,
  harnessId: AgentId,
): string | undefined {
  const modelId = session?.model;
  if (!session || !modelId) return modelId;

  // A row written while the model was current carries the full triple, so the
  // record to consult is that mode's and no other. A row that predates the
  // triple (or whose model the catalogue could not place when it was written)
  // carries the id alone, and is resolved with the same vendor bias every other
  // legacy id gets: before this feature a harness could reach nothing else.
  const successor =
    session.serviceId && session.billingMode
      ? retirementSuccessor(harnessId, {
          serviceId: session.serviceId,
          billingMode: session.billingMode,
          modelId,
        })
      : resolveRetiredModelId(harnessId, modelId, nativeServiceForHarness(harnessId));
  if (!successor) return modelId;

  // The successor is in the same `(service, mode)` by construction, so
  // `setModelSelection` keeps the pinned credential route — which is the point
  // of holding the mode fixed: the credential, the endpoint and whether the turn
  // is billed at all are all unchanged. What is NOT preserved is the rate: two
  // models under one key are priced differently, so a metered session's turns
  // can get cheaper or dearer across a remap. That is deliberate, and it is
  // visible because the session reports the model it moved to (req 11).
  try {
    sessions.setModelSelection(session.id, successor);
  } catch (err) {
    // A failed write is not a reason to spawn a model the service has retired,
    // so the session runs the successor anyway — req 13's promise is the one
    // worth keeping when the database is the thing that is broken.
    //
    // Stated plainly because it IS a breach of the write-through contract above:
    // for the length of this connection the picker shows the retired id while
    // the successor runs, and the per-connection selection already holds the
    // successor so nothing re-attempts the write until the next connect. The
    // alternative — spawning the retired model — fails the turn outright.
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
