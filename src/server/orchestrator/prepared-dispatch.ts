/**
 * Prepared dispatch — the branded, exhaustively-mapped option set that is the
 * ONLY thing `runner.dispatch` / `runner.runDispatchedTurn` will accept
 * (docs/240, Fix A).
 *
 * ## Why a brand
 *
 * `AgentDispatchOptions` is a wide bag of optional fields, and TypeScript cannot
 * catch a *missing optional*: `{ text }` is a perfectly valid
 * `AgentDispatchOptions` even though it has silently dropped `systemTurn`,
 * `onTurnComplete`, `postTurn`, `execution`, and `activity`. Every place that
 * turns a queued entry back into a running turn used to re-derive the options
 * field by field, so each new drain site quietly narrowed them:
 *
 *   - planning#257 — the interactive drain (and a third drain in
 *     `bootstrap-managers.ts`) rebuilt the options by hand and lost `systemTurn`
 *     + `onTurnComplete`; a notify-on-merge wake-turn queued behind a user turn
 *     ran as an ordinary turn and its watch never advanced.
 *   - planning#261 — turn adoption added a **fourth** hand-rolled drain doing exactly
 *     the same thing, days after planning#257 shipped, written by an author
 *     reasonably following the surrounding code. planning#257's own write-up had
 *     claimed a later drain "cannot re-narrow an entry without deliberately
 *     bypassing that module". Nobody bypassed anything deliberately.
 *
 * Convention did not hold, so the rule is moved into the type system. A
 * `PreparedDispatch` carries a brand keyed on a module-private `unique symbol`,
 * so it can only be produced HERE — by {@link queuedMessageToDispatchOptions}
 * (the queue drain) or {@link prepareDispatch} (a dispatch that does not come
 * off the queue). A hand-built object literal handed to `dispatch` is a
 * **compile error**, not something a reviewer has to notice.
 *
 * ## Why the init object is complete, not partial
 *
 * A brand is only as good as its producers. If `prepareDispatch` took a
 * `Partial<AgentDispatchOptions>` and filled in defaults it would re-open the
 * identical hole one level up — a drain site could call
 * `prepareDispatch({ text: next.text })` and lose everything else, with the
 * compiler's blessing. So {@link AgentDispatchInit} requires EVERY field to be
 * mentioned, explicitly `undefined` when not wanted. Dropping a field then
 * becomes a deliberate, visible act rather than an omission.
 *
 * Two independent compile-time checks keep the mapping exhaustive as the shape
 * grows: {@link AgentDispatchInit}'s key set is asserted equal to
 * `keyof AgentDispatchOptions`, and {@link DISPATCH_FIELDS} is a
 * `Record<keyof AgentDispatchOptions, true>` that the runtime copy iterates. Add
 * a field to `AgentDispatchOptions` and BOTH fail until it is handled here — and
 * every `prepareDispatch` caller fails too, because the init is complete.
 *
 * planning#257's converter round-trip test is still wanted alongside this: it guards a
 * different surface (a field dropped *inside* the converter) than the brand does
 * (the converter bypassed entirely).
 */

import type {
  AgentDispatchOptions,
  QueuedMessage,
} from "./session-runner.js";
import type { TurnOutcome, TurnSettlement } from "./turn-settlement.js";
import type {
  ImageAttachment,
  FileContextRef,
  UploadRef,
  PermissionMode,
} from "../shared/types.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";

// ---------------------------------------------------------------------------
// The brand
// ---------------------------------------------------------------------------

/**
 * Module-private brand key. NOT exported, so no other module can synthesize a
 * `PreparedDispatch` — the type is uninhabitable outside this file.
 */
declare const PREPARED: unique symbol;

/**
 * `AgentDispatchOptions` that provably came from one of this module's two
 * producers. `dispatch` / `runDispatchedTurn` accept nothing else.
 */
export type PreparedDispatch = AgentDispatchOptions & { readonly [PREPARED]: true };

// ---------------------------------------------------------------------------
// The complete init object
// ---------------------------------------------------------------------------

/**
 * A COMPLETE `AgentDispatchOptions` init: every field required, `undefined`
 * allowed for the ones this dispatch doesn't want. Written out longhand rather
 * than derived with a mapped type because `{ [K in keyof T]-?: T[K] | undefined }`
 * strips the `undefined` back out again (TS removes it for homomorphic mapped
 * types with `-?`), which would make every field mandatory-and-defined.
 *
 * The key-set assertions below make the longhand self-maintaining.
 */
export interface AgentDispatchInit {
  text: string;
  agentInterface: AgentInterfaceProvenance | undefined;
  messageOrigin?: AgentDispatchOptions["messageOrigin"];
  execution: "interactive" | "dispatched" | undefined;
  activity: string | undefined;
  images: ImageAttachment[] | undefined;
  files: FileContextRef[] | undefined;
  uploads: UploadRef[] | undefined;
  permissionMode: PermissionMode | undefined;
  postTurn: "commit-push" | "none" | undefined;
  systemTurn: boolean | undefined;
  onTurnComplete: ((outcome: TurnOutcome) => void) | undefined;
  deliveryId: string | undefined;
  dictated: boolean | undefined;
}

/** Compile-time `T extends never` assertion — the error message names the offender. */
type AssertNever<T extends never> = T;

/**
 * Adding a field to `AgentDispatchOptions` without adding it to
 * `AgentDispatchInit` fails here with `Type '"yourNewField"' does not satisfy
 * the constraint 'never'`.
 */
export type _InitCoversEveryDispatchField = AssertNever<
  Exclude<keyof AgentDispatchOptions, keyof AgentDispatchInit>
>;
/** …and the reverse, so a removed field can't linger in the init. */
export type _InitHasNoExtraFields = AssertNever<
  Exclude<keyof AgentDispatchInit, keyof AgentDispatchOptions>
>;

/**
 * Every field of `AgentDispatchOptions`, exhaustively — the runtime half of the
 * mapping. `prepareDispatch` copies exactly these keys, so a new field is picked
 * up by construction once it is listed here, and the `Record` type makes
 * forgetting to list it a compile error.
 */
const DISPATCH_FIELDS: Record<keyof AgentDispatchOptions, true> = {
  text: true,
  agentInterface: true,
  messageOrigin: true,
  execution: true,
  activity: true,
  images: true,
  files: true,
  uploads: true,
  permissionMode: true,
  postTurn: true,
  systemTurn: true,
  onTurnComplete: true,
  deliveryId: true,
  dictated: true,
};

const DISPATCH_FIELD_KEYS = Object.keys(DISPATCH_FIELDS) as (keyof AgentDispatchOptions)[];

// ---------------------------------------------------------------------------
// Producer 1 — a dispatch that does NOT come off the queue
// ---------------------------------------------------------------------------

/**
 * The explicit entry point for an originating dispatch: the notify-on-merge
 * wake-turn, a docs/233 session report, the CI auto-fix loop, the rebase driver,
 * `sendChildMessage`, a quick session's first turn, the WS handler's
 * "not steering" fall-through.
 *
 * Takes a COMPLETE {@link AgentDispatchInit} (see the module docblock) and drops
 * the `undefined`s, so the result keeps the exact optional-property shape the
 * rest of the system expects (`"systemTurn" in opts` stays false when unset).
 */
export function prepareDispatch(init: AgentDispatchInit): PreparedDispatch {
  const opts: AgentDispatchOptions = { text: init.text };
  const sink = opts as unknown as Record<string, unknown>;
  for (const key of DISPATCH_FIELD_KEYS) {
    if (key === "text") continue;
    const value = init[key];
    if (value !== undefined) sink[key] = value;
  }
  return opts as PreparedDispatch;
}

// ---------------------------------------------------------------------------
// Producer 2 — the queue drain
// ---------------------------------------------------------------------------

/**
 * Full `QueuedMessage` → `PreparedDispatch` conversion — the single supported
 * way to turn a queued entry back into a running turn. Every per-turn field a
 * queued entry can carry is restored, including the ones hand-rolled drains kept
 * dropping (`execution`, `systemTurn`, `postTurn`, and the `onTurnComplete` /
 * settlement chain).
 *
 * Mapped through the complete {@link AgentDispatchInit}, so a new
 * `AgentDispatchOptions` field breaks THIS FUNCTION until it is handled.
 */
export function queuedMessageToDispatchOptions(next: QueuedMessage): PreparedDispatch {
  return prepareDispatch({
    text: next.text,
    agentInterface: next.agentInterface,
    messageOrigin: next.messageOrigin,
    execution: next.execution,
    activity: next.activity,
    images: next.images,
    files: next.files,
    uploads: next.uploads,
    permissionMode: next.permissionMode,
    postTurn: next.postTurn,
    systemTurn: next.systemTurn,
    // docs/196 → docs/240 — carry the completion signal so an enqueued turn
    // still settles when it drains (the merge-watch busy path depends on this).
    onTurnComplete: next.onTurnComplete,
    // planning#266 — and the DURABLE half of the same signal, so the entry answers
    // `runner.hasDelivery(id)` for the whole time it waits in the queue.
    deliveryId: next.deliveryId,
    // docs/144 — a message dictated while a turn was running still tells the
    // agent it was transcribed when it finally drains.
    dictated: next.dictated,
  });
}

// ---------------------------------------------------------------------------
// Settlement chaining
// ---------------------------------------------------------------------------

/**
 * Chain a {@link TurnSettlement} onto a prepared dispatch's completion signal.
 *
 * This is the migration adapter of docs/240 Fix B: the settlement is implemented
 * ON TOP of the existing `onTurnComplete` field, which already rides the
 * in-memory queue through `toQueuedMessage` / `queuedMessageToDispatchOptions`.
 * So `dispatch` can hand back a `TurnHandle` today without moving the ~15
 * existing callback call sites, and a turn enqueued behind a running turn still
 * settles its handle when it later drains and runs.
 *
 * Re-branding here is safe by construction: the result is the input plus a
 * wrapper around one callback — no field can be lost.
 */
export function withSettlement(
  opts: PreparedDispatch,
  settlement: TurnSettlement,
): PreparedDispatch {
  const original = opts.onTurnComplete;
  const chained: PreparedDispatch = {
    ...opts,
    onTurnComplete: (outcome: TurnOutcome) => {
      // The caller's own callback runs first and is never skipped, even if it
      // throws — the settlement must still resolve or a consumer awaiting it
      // hangs forever.
      try {
        original?.(outcome);
      } finally {
        settlement.settle(outcome);
      }
    },
  };
  return chained;
}
