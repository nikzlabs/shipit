/**
 * planning#376 — the reported outcome of an allowlist add.
 *
 * These guard the complaint's shape: the two scopes behave very differently,
 * and every qualification below is a state where the confident answer would be
 * false — an unenforced deployment, a container that started Open, a session
 * with no live container, a reload that declined, and a session whose own
 * policy excludes user hosts entirely.
 */

import { describe, it, expect } from "vitest";
import { computeEgressGrantOutcome, type EgressGrantContext } from "./egress-grant-outcome.js";

const ctx = (over: Partial<EgressGrantContext>): EgressGrantContext => ({
  host: "example.com",
  scope: "global",
  reloaded: false,
  sessionId: "sess-1",
  enforcementActive: true,
  startedContained: true,
  excludedBySessionPolicy: false,
  ...over,
});

describe("computeEgressGrantOutcome", () => {
  it("a session add that reloaded is live everywhere with nothing pending", () => {
    // `reloadEgress` relaunches the resolver + proxy and re-contains every
    // running service, so there is no surface left holding the old list.
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: true }));
    expect(out.liveNow).toEqual(["new-containers", "agent", "services"]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
  });

  it("a session add that did NOT reload a contained, running session says so", () => {
    // `reloadEgress` also declines when the Tier B/C sidecars are disabled. The
    // agent really is holding the old list then, so the scope alone must not be
    // read as "it reloaded" — that is the same confident wrong claim again.
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
    // Containment is plumbed at creation: a container started Open is
    // unrestricted right now, whatever the config resolves to today.
    const out = computeEgressGrantOutcome(ctx({ startedContained: false }));
    expect(out.liveNow).toEqual(["new-containers", "agent", "services"]);
    expect(out.staleUntilRestart).toEqual([]);
  });

  // The mirror of the case above, and the one a policy-based rule gets wrong:
  // the user flipped the session to Open without restarting, so `reloadEgress`
  // declines — while the still-running container keeps the contained allowlist
  // it started with. "No restart needed" would be exactly backwards.
  it("a container that started CONTAINED is pending even after the policy went Open", () => {
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: false, startedContained: true }));
    expect(out.staleUntilRestart).toEqual(["agent", "services"]);
    expect(out.restartSessionId).toBe("sess-1");
  });

  it("a session with no live container has nothing to be stale or to restart", () => {
    // Even when the reload reported success (it refreshes services and returns
    // true without touching an agent container that isn't running yet).
    const out = computeEgressGrantOutcome(ctx({ scope: "session", reloaded: true, startedContained: null }));
    expect(out.liveNow).toEqual(["new-containers"]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
  });

  it("a global add with no session in scope states the general truth and offers no restart", () => {
    // The app-wide Settings editor: which sessions are running is not this
    // route's question, and "restart" would have no subject.
    const out = computeEgressGrantOutcome(ctx({ sessionId: null }));
    expect(out.liveNow).toEqual(["new-containers"]);
    expect(out.staleUntilRestart).toEqual(["agent", "services"]);
    expect(out.restartSessionId).toBeNull();
  });

  // docs/211 — a Network-off sandbox resolves to a lifeline-only config that
  // carries no user hosts, so the entry saves, the reload runs, and the session
  // still cannot reach the host. No restart ever fixes that.
  it("a session excluded by its own policy claims no surface and offers no restart", () => {
    const out = computeEgressGrantOutcome(
      ctx({ scope: "session", reloaded: true, excludedBySessionPolicy: true }),
    );
    expect(out.liveNow).toEqual([]);
    expect(out.staleUntilRestart).toEqual([]);
    expect(out.restartSessionId).toBeNull();
    expect(out.excludedBySessionPolicy).toBe(true);
  });

  it("carries the host as given, for the confirmation sentence", () => {
    expect(computeEgressGrantOutcome(ctx({ host: "fal.run" })).host).toBe("fal.run");
  });
});
