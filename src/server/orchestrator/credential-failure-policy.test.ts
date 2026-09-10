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
    const policy = credentialFailurePolicyForRoute("claude", "key", "anthropic");
    expect(policy).toMatchObject({ billingMode: "key", stopsOnFailure: true });
    expect(credentialFailurePolicyForRoute("claude", "sub", "zai")).toMatchObject({
      stopsOnFailure: false,
      vendorOwnedRecovery: false,
    });
  });

  it("vendor-owned recovery needs account machinery, not just a native service (docs/272)", () => {
    expect(credentialFailurePolicyForRoute("opencode", "sub", "opencode")).toMatchObject({
      stopsOnFailure: false,
      vendorOwnedRecovery: false,
    });
    expect(credentialFailurePolicyForRoute("claude", "sub", "anthropic")).toMatchObject({
      vendorOwnedRecovery: true,
    });
    expect(credentialFailurePolicyForRoute("codex", "sub", "openai")).toMatchObject({
      vendorOwnedRecovery: true,
    });
    expect(credentialFailurePolicyForRoute("opencode", undefined, undefined)).toMatchObject({
      vendorOwnedRecovery: true,
    });
  });

  it("ignores the dead provider_route_* columns on the session fallback (docs/260-turn-level-account-routing req 2)", () => {
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
    expect(
      credentialFailurePolicyFor(session({ agentId: "claude", serviceId: "anthropic", billingMode: "sub" }))
        .vendorOwnedRecovery,
    ).toBe(true);
    expect(credentialFailurePolicyFor(session({ agentId: "claude" })).vendorOwnedRecovery).toBe(true);
  });

  it("is false for a subscription that is not the harness's vendor", () => {
    expect(
      credentialFailurePolicyFor(session({ agentId: "claude", serviceId: "zai", billingMode: "sub" }))
        .vendorOwnedRecovery,
    ).toBe(false);
  });

  it("does not conflate the two axes", () => {
    const glm = credentialFailurePolicyFor(
      session({ agentId: "claude", serviceId: "zai", billingMode: "sub" }),
    );
    expect(glm).toMatchObject({ stopsOnFailure: false, vendorOwnedRecovery: false });
  });
});

it("routes OpenCode recovery to ChatGPT only for subscription billing", () => {
  expect(credentialFailurePolicyFor(session({ agentId: "opencode", serviceId: "openai", billingMode: "sub" })).vendorOwnedRecovery).toBe(true);
  expect(credentialFailurePolicyFor(session({ agentId: "opencode", serviceId: "openai", billingMode: "key" }))).toMatchObject({ stopsOnFailure: true, vendorOwnedRecovery: false });
});
