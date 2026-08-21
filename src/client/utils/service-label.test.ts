import { describe, it, expect } from "vitest";
import { billingModeLabel, serviceLabel } from "./service-label.js";

describe("serviceLabel (docs/252 req 16)", () => {
  it("names a service from the catalogue, not from a hand-kept table", () => {
    expect(serviceLabel("anthropic")).toBe("Anthropic");
    expect(serviceLabel("zai")).toBe("GLM (Z.ai)");
  });

  it("falls back to the raw id for a service the catalogue no longer carries", () => {
    // A retired service's history stays valuable (its rows keep their persisted
    // rates), so the group must still render. An id is a worse label than a
    // name, but never a wrong one.
    expect(serviceLabel("some-retired-service")).toBe("some-retired-service");
  });
});

describe("billingModeLabel", () => {
  it("uses the picker's words, so one split reads the same everywhere", () => {
    expect(billingModeLabel("sub")).toBe("Subscription");
    expect(billingModeLabel("key")).toBe("API key");
  });
});
