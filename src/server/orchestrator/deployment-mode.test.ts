import { describe, it, expect } from "vitest";
import { resolveDeploymentMode } from "./deployment-mode.js";

/**
 * docs/284 req 13 — this switches ShipIt's default memory budget from the whole
 * machine to half of it, so a value that is merely *close* to "local" must not
 * silently halve a server's budget.
 */
describe("resolveDeploymentMode", () => {
  it("is server when unset", () => {
    expect(resolveDeploymentMode({})).toBe("server");
  });

  it("is local for an exact SHIPIT_DEPLOYMENT=local, case- and space-insensitive", () => {
    expect(resolveDeploymentMode({ SHIPIT_DEPLOYMENT: "local" })).toBe("local");
    expect(resolveDeploymentMode({ SHIPIT_DEPLOYMENT: " Local " })).toBe("local");
  });

  it("falls back to server for anything else", () => {
    expect(resolveDeploymentMode({ SHIPIT_DEPLOYMENT: "" })).toBe("server");
    expect(resolveDeploymentMode({ SHIPIT_DEPLOYMENT: "laptop" })).toBe("server");
    expect(resolveDeploymentMode({ SHIPIT_DEPLOYMENT: "1" })).toBe("server");
  });

  // RUNTIME_MODE=local is the dogfood inner instance (no Docker at all). The
  // two are independent, and reading one for the other would give every
  // dogfood run a halved budget it never asked for.
  it("ignores RUNTIME_MODE", () => {
    expect(resolveDeploymentMode({ RUNTIME_MODE: "local" })).toBe("server");
  });
});
