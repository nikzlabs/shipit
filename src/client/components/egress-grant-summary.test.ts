/**
 * planning#376 — the wording both grant surfaces share.
 *
 * These assert the CLAIMS, not the prose: which surfaces the sentence says are
 * live, and whether a restart is offered. The defect being guarded is a
 * confident sentence about the wrong surface — the old tooltip named services
 * and not the agent — so a test that only checked "some text rendered" would
 * have passed on it.
 */

import { describe, it, expect } from "vitest";
import { egressBlockedReason, summarizeEgressGrant } from "./egress-grant-summary.js";
import type { EgressHostGrantOutcome } from "../../server/shared/types.js";

const outcome = (over: Partial<EgressHostGrantOutcome>): EgressHostGrantOutcome => ({
  host: "fal.run",
  scope: "global",
  liveNow: ["new-containers"],
  staleUntilRestart: ["agent", "services"],
  restartSessionId: "sess-1",
  reach: "grantable",
  ...over,
});

describe("summarizeEgressGrant", () => {
  it("a session grant says it is live everywhere with no restart", () => {
    const s = summarizeEgressGrant(
      outcome({
        scope: "session",
        liveNow: ["new-containers", "agent", "services"],
        staleUntilRestart: [],
        restartSessionId: null,
      }),
    );
    expect(s.kind).toBe("live-everywhere");
    expect(s.headline).toContain("for this session");
    expect(s.detail).toContain("No restart needed");
    expect(s.restartSessionId).toBeNull();
  });

  it("a global grant names the agent as well as services, and offers the restart", () => {
    const s = summarizeEgressGrant(outcome({}));
    expect(s.kind).toBe("partly-live");
    expect(s.headline).toContain("for every session");
    // The whole complaint: the agent was the surface nobody was told about.
    expect(s.detail).toContain("agent");
    expect(s.detail).toContain("running service");
    // And the plugin CLI is the opposite of stale — created per invocation.
    expect(s.detail).toContain("per invocation");
    expect(s.restartSessionId).toBe("sess-1");
  });

  it("a global grant with no session in scope speaks generally and offers no restart", () => {
    const s = summarizeEgressGrant(outcome({ restartSessionId: null }));
    expect(s.kind).toBe("partly-live");
    expect(s.detail).toContain("Sessions already running");
    expect(s.restartSessionId).toBeNull();
  });

  it("claims nothing is stale when the server says nothing is", () => {
    const s = summarizeEgressGrant(
      outcome({ staleUntilRestart: [], restartSessionId: null }),
    );
    expect(s.kind).toBe("next-start");
    expect(s.detail).not.toContain("until they restart");
    expect(s.restartSessionId).toBeNull();
  });

  it("says containment isn't in effect rather than claiming a reload happened", () => {
    const s = summarizeEgressGrant(
      outcome({
        liveNow: ["new-containers", "agent", "services"],
        staleUntilRestart: [],
        restartSessionId: null,
      }),
    );
    expect(s.kind).toBe("live-everywhere");
    expect(s.detail).toContain("not in effect");
  });

  // docs/211 — the session's own policy carries no user hosts, so "allowed"
  // would be the flattest wrong claim of the set, and a restart fixes nothing.
  it("an excluded session is told it still can't reach the host, with no restart", () => {
    const s = summarizeEgressGrant(
      outcome({
        scope: "session",
        liveNow: [],
        staleUntilRestart: [],
        restartSessionId: null,
        reach: "blocked-by-session",
      }),
    );
    expect(s.kind).toBe("excluded");
    expect(s.detail).toContain("can't reach it");
    expect(s.detail).toContain("network access is off");
    expect(s.restartSessionId).toBeNull();
  });

  // planning#383 — the same claim one level up, and the one the old boolean
  // could not express: the entry saved, and NO session on this deployment can
  // act on it, so the report must not say "anything started from now on has it".
  it("a deployment that can grant nothing says so, and blames nobody the user can be", () => {
    const s = summarizeEgressGrant(
      outcome({ liveNow: [], staleUntilRestart: [], restartSessionId: null, reach: "blocked-by-deployment" }),
    );
    expect(s.kind).toBe("excluded");
    expect(s.detail).toContain("can't allow extra hosts");
    expect(s.detail).toContain("Whoever runs this ShipIt");
    expect(s.detail).not.toContain("Anything started from now on");
    expect(s.restartSessionId).toBeNull();
  });

  // The row the Plugins card renders INSTEAD of a grant button reads the same
  // helper, so the before-the-click and after-the-click wordings cannot drift.
  it("egressBlockedReason answers for the two blocked verdicts and nothing else", () => {
    expect(egressBlockedReason("blocked-by-deployment")?.headline).toContain("This ShipIt can't allow extra hosts");
    expect(egressBlockedReason("blocked-by-session")?.headline).toContain("whatever the allowlist says");
    expect(egressBlockedReason("grantable")).toBeNull();
    expect(egressBlockedReason("allowed")).toBeNull();
  });

  it("quotes the host as markup the renderer turns into code", () => {
    expect(summarizeEgressGrant(outcome({})).headline).toContain("`fal.run`");
  });
});
