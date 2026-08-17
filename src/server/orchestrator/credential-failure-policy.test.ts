import { describe, expect, it } from "vitest";
import {
  credentialFailurePolicyFor,
  credentialFailurePolicyForRoute,
  credentialFailureStopMessage,
  stopsOnCredentialFailure,
} from "./credential-failure-policy.js";
import type { SessionInfo } from "../shared/types.js";

const session = (over: Partial<SessionInfo>): Partial<SessionInfo> => over;

describe("credentialFailurePolicyFor — docs/252 req 12", () => {
  it("branches on the billing mode, not on how the credential is delivered", () => {
    // GLM's coding plan is a SUBSCRIPTION authenticated by a supplied key, and
    // `claude-env-oauth` is a SUBSCRIPTION delivered as an environment string.
    // A rule keyed on "is this a key?" would stop both instead of failing over.
    expect(
      stopsOnCredentialFailure(session({ serviceId: "zai", billingMode: "sub" })),
    ).toBe(false);
    expect(
      stopsOnCredentialFailure(
        session({ serviceId: "anthropic", billingMode: "sub", providerRouteId: "claude-env-oauth" }),
      ),
    ).toBe(false);
    expect(
      stopsOnCredentialFailure(session({ serviceId: "deepseek", billingMode: "key" })),
    ).toBe(true);
  });

  it("the captured route's mode decides via the route-shaped entry point", () => {
    // Phase 1's rule survives docs/260 in a new home: a route's billing mode
    // is a property of the route, and under per-turn routing that route is
    // the TURN'S OWN capture, resolved by the executor's `routeProfile` dep
    // and answered here.
    const policy = credentialFailurePolicyForRoute("claude", "key", "anthropic");
    expect(policy).toMatchObject({ billingMode: "key", stopsOnFailure: true });
    expect(credentialFailurePolicyForRoute("claude", "sub", "zai")).toMatchObject({
      stopsOnFailure: false,
      vendorOwnedRecovery: false,
    });
  });

  it("ignores the dead provider_route_* columns on the session fallback (docs/260-turn-level-account-routing req 2)", () => {
    // Nothing writes those columns any more, so a value there is a pre-260
    // leftover. Letting it override the live selection was a hidden
    // per-session pin deciding whether a turn retries.
    const policy = credentialFailurePolicyFor(
      session({
        serviceId: "anthropic",
        billingMode: "sub",
        providerRouteServiceId: "anthropic",
        providerRouteBillingMode: "key",
      }),
    );
    expect(policy).toMatchObject({ billingMode: "sub", stopsOnFailure: false });
  });

  it("keeps today's behaviour for a session that names no mode at all", () => {
    // A pre-feature row, or a first turn that failed before pinning. Answering
    // `key` here would stop turns that recover fine today.
    expect(stopsOnCredentialFailure(session({}))).toBe(false);
    expect(stopsOnCredentialFailure(undefined)).toBe(false);
  });

  it("names the service in the stop message, and does not offer a sign-in", () => {
    const message = credentialFailureStopMessage(
      credentialFailurePolicyFor(session({ serviceId: "deepseek", billingMode: "key" })),
    );
    expect(message).toContain("DeepSeek");
    expect(message).toContain("Settings → Services");
    expect(message.toLowerCase()).not.toContain("sign in");
  });

  it("still says something usable when the service is unknown", () => {
    const message = credentialFailureStopMessage({
      billingMode: "key",
      serviceId: undefined,
      stopsOnFailure: true,
      vendorOwnedRecovery: true,
    });
    expect(message).toContain("API key");
  });
});

describe("vendorOwnedRecovery — whose healer can act on this credential", () => {
  it("is true for the harness's own vendor, and for a session that names none", () => {
    // Anthropic's OAuth healer and silent refresher are exactly what a failing
    // Anthropic subscription needs, and a pre-feature row must behave as it did.
    expect(
      credentialFailurePolicyFor(session({ agentId: "claude", serviceId: "anthropic", billingMode: "sub" }))
        .vendorOwnedRecovery,
    ).toBe(true);
    expect(credentialFailurePolicyFor(session({ agentId: "claude" })).vendorOwnedRecovery).toBe(true);
  });

  it("is false for a subscription that is not the harness's vendor", () => {
    // GLM's coding plan on the Claude harness: there is no OAuth token to heal
    // and no refresher to nudge, so running Anthropic's would heal something
    // unrelated and report the wrong service as broken.
    expect(
      credentialFailurePolicyFor(session({ agentId: "claude", serviceId: "zai", billingMode: "sub" }))
        .vendorOwnedRecovery,
    ).toBe(false);
  });

  it("does not conflate the two axes", () => {
    // A non-vendor SUBSCRIPTION still fails over (`stopsOnFailure` false); only
    // a `key` stops. Collapsing them would turn a GLM plan outage into a stopped
    // session, which is the mistake req 12 is written to prevent.
    const glm = credentialFailurePolicyFor(
      session({ agentId: "claude", serviceId: "zai", billingMode: "sub" }),
    );
    expect(glm).toMatchObject({ stopsOnFailure: false, vendorOwnedRecovery: false });
  });
});
