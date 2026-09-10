import { describe, it, expect } from "vitest";
import { resolveDeploymentMode } from "./deployment-mode.js";

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

  it("ignores RUNTIME_MODE", () => {
    expect(resolveDeploymentMode({ RUNTIME_MODE: "local" })).toBe("server");
  });
});
