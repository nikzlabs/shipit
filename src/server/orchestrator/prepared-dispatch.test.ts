/**
 * docs/240 Fix A — the branded prepared dispatch.
 *
 * The load-bearing assertions here are TYPE-level (`@ts-expect-error`), because
 * the property under test is "this does not compile" and no runtime test can
 * express that. `npm run typecheck` compiles this file, so an `@ts-expect-error`
 * that stops being an error fails the build with "Unused '@ts-expect-error'
 * directive" — i.e. the guard fails loudly if the brand is ever removed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  prepareDispatch,
  queuedMessageToDispatchOptions,
  withSettlement,
  type AgentDispatchInit,
  type PreparedDispatch,
} from "./prepared-dispatch.js";
import { SessionRunner, toQueuedMessage } from "./session-runner.js";
import type { AgentDispatchOptions, QueuedMessage } from "./session-runner.js";
import { createTurnSettlement, TURN_COMPLETED } from "./turn-settlement.js";
import type { AgentId } from "../shared/types.js";

/** Every field, so the exhaustiveness assertions below have something to chew on. */
const FULL_INIT: AgentDispatchInit = {
  text: "everything",
  execution: "dispatched",
  activity: "Working…",
  images: [{ data: "abc", mediaType: "image/png" }],
  files: [{ path: "src/a.ts" }],
  uploads: [{ path: "/uploads/a.png", type: "upload" }],
  permissionMode: "plan",
  postTurn: "none",
  systemTurn: true,
  onTurnComplete: () => {},
  deliveryId: "watch-1:1",
};

function newRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

describe("PreparedDispatch brand (docs/240 Fix A)", () => {
  it("SHI-259: a hand-built AgentDispatchOptions cannot be dispatched (type-level)", () => {
    const runner = newRunner();

    // THE regression guard. SHI-259's turn-adoption drain built exactly this
    // shape — `{ text }` plus a few attachment fields — and handed it to
    // `runner.dispatch`, silently dropping `execution`, `systemTurn`,
    // `postTurn`, and `onTurnComplete`. It typechecked, so nothing caught it
    // until a notify-on-merge watch stranded in production.
    const handRolled: AgentDispatchOptions = { text: "child PR merged", activity: "Resuming…" };
    // @ts-expect-error SHI-259 — dispatch accepts only a PreparedDispatch; a
    // hand-built literal (the shape every re-narrowing drain produced) must not
    // compile. If this line stops erroring, Fix A has been undone.
    runner.dispatch(handRolled);

    // @ts-expect-error SHI-259 — the same for an inline literal.
    runner.dispatch({ text: "inline literal" });

    // @ts-expect-error SHI-259 — and for the direct executor entry point.
    void runner.runDispatchedTurn({ text: "inline literal" });

    runner.dispose({ force: true });
    expect(true).toBe(true);
  });

  it("prepareDispatch requires a COMPLETE init — a partial re-opens the hole one level up (type-level)", () => {
    // The doc's stated risk: "a brand is only as good as its producers. If
    // `prepareDispatch` accepts a partial and fills defaults, it re-opens the
    // same hole one level up." So every field must be mentioned, explicitly
    // `undefined` when unwanted — dropping one becomes deliberate and visible.

    // @ts-expect-error docs/240 — an incomplete init must not compile.
    prepareDispatch({ text: "only text" });

    // @ts-expect-error docs/240 — nor one that mentions only the easy fields
    // (this is precisely the shape a lazy drain site would reach for).
    prepareDispatch({ text: "x", activity: "y", images: undefined });

    expect(prepareDispatch(FULL_INIT).text).toBe("everything");
  });

  it("drops undefined fields rather than materializing them as present-but-undefined", () => {
    const opts = prepareDispatch({ ...FULL_INIT, systemTurn: undefined, activity: undefined });
    expect("systemTurn" in opts).toBe(false);
    expect("activity" in opts).toBe(false);
    expect("text" in opts).toBe(true);
  });

  it("the converter carries EVERY AgentDispatchOptions field out of a queued entry", () => {
    // Runtime companion to the compile-time exhaustiveness checks in
    // `prepared-dispatch.ts`: adding a field to `AgentDispatchOptions` without
    // teaching `AgentDispatchInit` / `DISPATCH_FIELDS` / the converter about it
    // fails to compile there, and dropping it in the mapping fails here.
    const queued: QueuedMessage = toQueuedMessage(prepareDispatch(FULL_INIT));
    const restored = queuedMessageToDispatchOptions(queued);
    for (const key of Object.keys(prepareDispatch(FULL_INIT)) as (keyof AgentDispatchOptions)[]) {
      expect(restored[key], `field "${key}" was dropped by the converter`).toEqual(
        prepareDispatch(FULL_INIT)[key],
      );
    }
  });

  it("the converter's output is itself dispatchable (the drain has a legal path)", () => {
    const runner = newRunner();
    const prepared: PreparedDispatch = queuedMessageToDispatchOptions({
      text: "drained",
      execution: "dispatched",
      systemTurn: true,
    });
    // No deps wired ⇒ dispatch falls back to enqueue; the point is that it
    // TYPECHECKS, unlike the hand-rolled literal above.
    runner.dispatch(prepared);
    expect(runner.queueLength).toBe(1);
    expect(runner.messageQueue[0]!.systemTurn).toBe(true);
    runner.dispose({ force: true });
  });

  it("withSettlement chains the caller's callback and never skips the settle, even if it throws", async () => {
    const settlement = createTurnSettlement();
    const original = vi.fn(() => { throw new Error("consumer blew up"); });
    const chained = withSettlement(
      prepareDispatch({ ...FULL_INIT, onTurnComplete: original }),
      settlement,
    );

    expect(() => chained.onTurnComplete!(TURN_COMPLETED)).toThrow("consumer blew up");
    expect(original).toHaveBeenCalledWith(TURN_COMPLETED);
    // The settlement resolved despite the throw — a consumer awaiting the handle
    // must never be stranded by someone else's bad callback.
    await expect(settlement.settled).resolves.toEqual(TURN_COMPLETED);
  });
});
