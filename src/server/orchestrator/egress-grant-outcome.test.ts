import { describe, it, expect } from "vitest";
import { computeEgressGrantOutcome, type EgressGrantContext } from "./egress-grant-outcome.js";

const ctx = (over: Partial<EgressGrantContext>): EgressGrantContext => ({
  host: "example.com",
  scope: "global",
  reloaded: false,
  sessionId: "sess-1",
  enforcementActive: true,
  startedContained: true,
  reach: "grantable",
  ...over,
});

describe("computeEgressGrantOutcome", () => {
  it("a session add that reloaded is live everywhere with nothing pending", () => {
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: true }));
    expect(out.liveNow).toEqual(["new-containers", "agent", "services"]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
  });

  it("a session add that did NOT reload a contained, running session says so", () => {
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: false }));
    expect(out.staleUntilRestart).toEqual(["agent", "services"]);
    expect(out.restartSessionId).toBe("sess-1");
  });

  it("a global add names the AGENT as stale too, and offers that session's restart", () => {
    const out = computeEgressGrantOutcome(ctx({}));
    expect(out.liveNow).toEqual(["new-containers"]);
    expect(out.staleUntilRestart).toEqual(["agent", "services"]);
    expect(out.restartSessionId).toBe("sess-1");
  });

  it("names the agent, not only services — the tooltip's original error", () => {
    expect(computeEgressGrantOutcome(ctx({})).staleUntilRestart).toContain("agent");
  });

  it("claims nothing when the deployment can't enforce containment", () => {
    const out = computeEgressGrantOutcome(ctx({ enforcementActive: false }));
    expect(out.liveNow).toEqual(["new-containers", "agent", "services"]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
  });

  it("a container that STARTED open holds no snapshot, so nothing is pending", () => {
    const out = computeEgressGrantOutcome(ctx({ startedContained: false }));
    expect(out.liveNow).toEqual(["new-containers", "agent", "services"]);
    expect(out.staleUntilRestart).toEqual([]);
  });

  it("a container that started CONTAINED is pending even after the policy went Open", () => {
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: false, startedContained: true }));
    expect(out.staleUntilRestart).toEqual(["agent", "services"]);
    expect(out.restartSessionId).toBe("sess-1");
  });

  it("a session with no live container has nothing to be stale or to restart", () => {
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: true, startedContained: null }));
    expect(out.liveNow).toEqual(["new-containers"]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
  });

  it("a global add with no session in scope states the general truth and offers no restart", () => {
    const out = computeEgressGrantOutcome(ctx({ sessionId: null }));
    expect(out.liveNow).toEqual(["new-containers"]);
    expect(out.staleUntilRestart).toEqual(["agent", "services"]);
    expect(out.restartSessionId).toBeNull();
  });

  it("a session excluded by its own policy claims no surface and offers no restart", () => {
    const out = computeEgressGrantOutcome(
      ctx({ scope: "session", reloaded: true, reach: "blocked-by-session" }),
    );
    expect(out.liveNow).toEqual([]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
    expect(out.reach).toBe("blocked-by-session");
  });

  it("a deployment that can grant nothing claims no surface either", () => {
    const out = computeEgressGrantOutcome(ctx({ reach: "blocked-by-deployment" }));
    expect(out.liveNow).toEqual([]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
    expect(out.reach).toBe("blocked-by-deployment");
  });

  it("blocks before the enforcement branch — 'not enforced' must not read as live", () => {
    const out = computeEgressGrantOutcome(ctx({ enforcementActive: false, reach: "blocked-by-deployment" }));
    expect(out.liveNow).toEqual([]);
  });

  it("carries the host as given, for the confirmation sentence", () => {
    expect(computeEgressGrantOutcome(ctx({ host: "fal.run" })).host).toBe("fal.run");
  });
});
