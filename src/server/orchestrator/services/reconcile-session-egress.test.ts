import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { EgressAllowlistStore } from "../egress-allowlist-store.js";
import {
  reconcileSessionEgress,
  containerDisagreesWithEgressPolicy,
  type ReconcileEgressDeps,
} from "./reconcile-session-egress.js";
import type { RecoveryDeps } from "./recovery.js";

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
      resolveEgress: (id: string) => ({ contained: store.resolveContained(id), extraHosts: [] }),
    } as unknown as ReconcileEgressDeps["containerManager"],
    egressAllowlistStore: store,
    recovery: {} as RecoveryDeps,
    ...over,
  });

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    store.setGlobalEnabled(true);
    containers = new Map();
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
      store.setSessionOverride("s1", false);
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
    });

    it("treats an UNKNOWN boot mode as disagreement, never as matching", () => {
      containers.set("s1", { status: "running", egressContainedAtStart: undefined });
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
      store.setSessionOverride("s1", true);
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
      store.setSessionOverride("s1", false);
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
    });

    it("treats a still-STARTING container as disagreement", () => {
      containers.set("s1", { status: "starting" });
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(true);
    });

    it("has nothing to reconcile when no container exists yet", () => {
      expect(containerDisagreesWithEgressPolicy(deps(), "s1")).toBe(false);
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
    expect(restartMock.mock.calls[0]?.[2]).toMatchObject({ resetBreakers: false });
  });

  it("carries the caller's agent seed into the replacement runner", async () => {
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
