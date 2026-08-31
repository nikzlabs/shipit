import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { EgressAllowlistStore } from "../egress-allowlist-store.js";
import {
  reconcileSessionEgress,
  containerDisagreesWithEgressPolicy,
  type ReconcileEgressDeps,
} from "./reconcile-session-egress.js";
import type { RecoveryDeps } from "./recovery.js";
import {
  firstTurnEgressPin,
  consumeFirstTurnEgressPin,
  _resetFirstTurnAdmission,
} from "./first-turn-admission.js";

/**
 * docs/285 — the first-Send reconciliation: does the live container disagree
 * with the mode this session resolves to, and what happens when it does.
 */

vi.mock("./recovery.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal is generic over the module's own type, which only an inline import() can name
  const actual = await importOriginal<typeof import("./recovery.js")>();
  return { ...actual, restartContainer: vi.fn() };
});
const { restartContainer } = await import("./recovery.js");
const restartMock = vi.mocked(restartContainer);

describe("reconcileSessionEgress (docs/285)", () => {
  let db: DatabaseManager;
  let store: EgressAllowlistStore;
  let containers: Map<string, { status: string; egressContainedAtStart?: boolean | null }>;

  const deps = (over: Partial<ReconcileEgressDeps> = {}): ReconcileEgressDeps => ({
    containerManager: {
      get: (id: string) => containers.get(id),
      // Mirrors production's `resolveEgressConfig`, whose containment input IS
      // the store. Present on the fake because it is present on the real
      // manager: a fake missing it would send every case down the store
      // fallback, and the sandbox test below could not tell the two apart.
      resolveEgress: (id: string) => ({ contained: store.resolveContained(id), extraHosts: [] }),
    } as unknown as ReconcileEgressDeps["containerManager"],
    egressAllowlistStore: store,
    recovery: {} as RecoveryDeps,
    ...over,
  });

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    store.setGlobalEnabled(true); // workspace default: Contained
    containers = new Map();
    _resetFirstTurnAdmission();
    restartMock.mockReset();
    restartMock.mockResolvedValue({
      ok: true,
      noContainer: false,
      newContainerState: "running",
      error: null,
    });
  });

  describe("what counts as disagreement", () => {
    it("agrees when the running container's boot mode matches the resolved mode", () => {
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(false);
    });

    it("disagrees when the override resolves differently than the container booted", () => {
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      store.setSessionOverride("s1", false); // force Open
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
    });

    it("treats an UNKNOWN boot mode as disagreement, never as matching", () => {
      // The trap this exists for: `isEgressContained()` re-derives the CURRENT
      // policy when the boot state is unknown, so reading it here would answer
      // "matches" for a container nobody knows the containment of — and run the
      // first turn under the wrong mode. Only the raw record is admissible.
      containers.set("s1", { status: "running", egressContainedAtStart: undefined });
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
      // …and it stays disagreement whichever way the policy would have resolved.
      store.setSessionOverride("s1", true);
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
      store.setSessionOverride("s1", false);
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
    });

    it("treats a still-STARTING container as disagreement", () => {
      // Costs an unnecessary restart in a rare case; cannot silently run the
      // first turn under the wrong mode. `restartContainer`'s destroy cancels a
      // creation that has published no record yet, so this is handled.
      containers.set("s1", { status: "starting" });
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
    });

    it("has nothing to reconcile when no container exists yet", () => {
      // The next create resolves the mode fresh, so there is nothing to rebuild.
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(false);
    });
  });

  /**
   * docs/285 — the pin is what makes the guarantee hold, and the restart is only
   * how the container catches up to it.
   *
   * The rebuild is asynchronous and creation resolves containment when it reaches
   * the plumbing step, so a settings write landing after this function returns
   * used to decide the mode of a turn already admitted. These cover the value
   * being frozen, surviving the write, and ending with the turn.
   */
  describe("freezing the admitted turn's mode", () => {
    it("pins the explicitly picked mode", async () => {
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      store.setSessionOverride("s1", false); // the user picked Open
      await reconcileSessionEgress(deps(), "s1");
      expect(firstTurnEgressPin("s1")).toBe(false);
    });

    it("pins even when no restart was needed", async () => {
      // The agreeing case returns before any restart, and it still has to freeze:
      // "the container already matches" is a statement about NOW, and creation
      // can re-resolve later for reasons this function never saw.
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      store.setSessionOverride("s1", true);
      const outcome = await reconcileSessionEgress(deps(), "s1");
      expect(outcome).toEqual({ action: "none", reason: "matches" });
      expect(firstTurnEgressPin("s1")).toBe(true);
    });

    it("does NOT pin Inherit — req 3 leaves that one movable, and req 10 says so", async () => {
      // Requirement 3, in the human's words: "Inherit workspace means the
      // workspace setting as it stands when the session's container starts —
      // which is what 'inherit' says, and the only case a workspace-default
      // change during Send can move." Requirement 10 then requires the control
      // not to present the inherited value as pinned. Pinning what Inherit
      // happens to resolve to would close a race the human deliberately left
      // open AND make the UI's own words false — a requirement reversed by
      // mechanism rather than by the human.
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      expect(store.getSessionOverride("s1")).toBeNull(); // Inherit
      await reconcileSessionEgress(deps(), "s1");
      expect(firstTurnEgressPin("s1")).toBeUndefined();
    });

    it("holds the admitted mode against a write that lands during the rebuild", async () => {
      // The failure this replaces: the write won, because whatever the store said
      // when creation reached the plumbing step decided the mode. Now the store
      // moves and the admitted turn does not.
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      store.setSessionOverride("s1", false); // admitted as Open
      await reconcileSessionEgress(deps(), "s1");

      store.setSessionOverride("s1", true); // a settings PUT, mid-rebuild
      expect(store.resolveContained("s1")).toBe(true);
      // Creation reads the pin, so the turn still runs Open — and the write is
      // not lost, it is pending the next container start.
      expect(firstTurnEgressPin("s1")).toBe(false);

      // The pin ends when a container is BUILT with it, not when the handler
      // returns — the agent start is fire-and-forget, so the handler returns
      // while the rebuild is still in flight.
      consumeFirstTurnEgressPin("s1");
      expect(firstTurnEgressPin("s1")).toBeUndefined();
      expect(store.resolveContained("s1")).toBe(true);
    });

    it("resolves through the container manager's seam, not the store directly", async () => {
      // The store is an INPUT to the resolver, not its output: a docs/211 sandbox
      // with `network` off resolves contained however the override reads.
      // Comparing the store's answer against a container built from the
      // resolver's would report a disagreement no rebuild can fix — a first Send
      // that restarts the container and still disagrees.
      containers.set("s1", { status: "running", egressContainedAtStart: true });
      store.setSessionOverride("s1", false); // Open, per the store
      const sealed = deps({
        containerManager: {
          get: (id: string) => containers.get(id),
          // …but this session is sealed, so the resolver says contained.
          resolveEgress: () => ({ contained: true, extraHosts: [] }),
        } as unknown as ReconcileEgressDeps["containerManager"],
      });
      expect(containerDisagreesWithEgressPolicy(sealed, "s1")).toBe(false);
      await reconcileSessionEgress(sealed, "s1");
      expect(restartMock).not.toHaveBeenCalled();
      // Pinned to what the RESOLVER said (contained), not to the override (open).
      expect(firstTurnEgressPin("s1")).toBe(true);
    });
  });

  it("does nothing, and does not restart, when the container already matches", async () => {
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    const outcome = await reconcileSessionEgress(deps(), "s1");
    expect(outcome).toEqual({ action: "none", reason: "matches" });
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("restarts on a mismatch, WITHOUT Rescue's breaker reset", async () => {
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    store.setSessionOverride("s1", false);
    const outcome = await reconcileSessionEgress(deps(), "s1");
    expect(outcome).toEqual({ action: "restarted" });
    // Rescue clears the OOM breaker because the user explicitly asked to retry.
    // Changing a setting is not that request: inheriting the reset would hand a
    // repeatedly-OOM-killed session a free attempt that an unchanged first Send
    // is refused.
    expect(restartMock.mock.calls[0]?.[2]).toMatchObject({ resetBreakers: false });
  });

  it("carries the caller's agent seed into the replacement runner", async () => {
    // Quick Capture has RESOLVED the harness but not persisted it, so without
    // this the replacement is seeded with the deployment default — picking Codex
    // and changing the network mode would dispatch the turn to Claude.
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    store.setSessionOverride("s1", false);
    await reconcileSessionEgress(deps(), "s1", { agentSeed: "codex" });
    expect(restartMock.mock.calls[0]?.[2]).toMatchObject({ agentSeed: "codex" });
  });

  it("aborts on a tripped breaker and offers Rescue instead of becoming it", async () => {
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    store.setSessionOverride("s1", false);
    const outcome = await reconcileSessionEgress(
      deps({ oomBreaker: { isTripped: () => true } as unknown as ReconcileEgressDeps["oomBreaker"] }),
      "s1",
    );
    expect(outcome).toMatchObject({ action: "aborted", offerRescue: true });
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("aborts when the replacement failed to be created", async () => {
    // `restartContainer` reports `ok: true` even here — dispatching on that would
    // send the first turn into a container that does not exist.
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    store.setSessionOverride("s1", false);
    restartMock.mockResolvedValue({
      ok: true,
      noContainer: false,
      newContainerState: "missing",
      error: "no space left on device",
    });
    const outcome = await reconcileSessionEgress(deps(), "s1");
    expect(outcome).toMatchObject({ action: "aborted", offerRescue: false });
    expect((outcome as { message: string }).message).toMatch(/no space left on device/);
  });

  it("proceeds when the replacement is still starting", async () => {
    // The caller waits on the NEW runner's readiness gate, not on this call
    // having returned — `restartContainer`'s own wait is bounded at 8s.
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    store.setSessionOverride("s1", false);
    restartMock.mockResolvedValue({
      ok: true,
      noContainer: false,
      newContainerState: "starting",
      error: null,
    });
    expect(await reconcileSessionEgress(deps(), "s1")).toEqual({ action: "restarted" });
  });

  it("reconciles nothing in a runtime with no container manager, rather than failing the Send", async () => {
    // `RUNTIME_MODE=local` — no container manager, so `restartContainer` would
    // throw a 503. The override is persisted and there is no topology to
    // rebuild, so the first Send must proceed instead of failing on a subsystem
    // this runtime does not have.
    containers.set("s1", { status: "running", egressContainedAtStart: true });
    store.setSessionOverride("s1", false);
    const outcome = await reconcileSessionEgress(
      { ...deps(), containerManager: null },
      "s1",
    );
    expect(outcome).toEqual({ action: "none", reason: "matches" });
    expect(restartMock).not.toHaveBeenCalled();
  });
});
