import { describe, it, expect, vi, afterEach } from "vitest";
import { registerServiceWorker } from "./register-service-worker.js";

describe("registerServiceWorker", () => {
  const originalSW = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;

  afterEach(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      value: originalSW,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function setServiceWorker(value: unknown) {
    Object.defineProperty(navigator, "serviceWorker", { value, configurable: true });
  }

  it("registers the worker at root scope with cache bypass on load", () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ update });
    setServiceWorker({ register });

    registerServiceWorker();
    window.dispatchEvent(new Event("load"));

    expect(register).toHaveBeenCalledWith("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("is a no-op when service workers are unsupported", () => {
    setServiceWorker(undefined);
    expect(() => {
      registerServiceWorker();
      window.dispatchEvent(new Event("load"));
    }).not.toThrow();
  });

  it("swallows registration failures so the app still boots", () => {
    const register = vi.fn().mockRejectedValue(new Error("nope"));
    setServiceWorker({ register });

    registerServiceWorker();
    expect(() => window.dispatchEvent(new Event("load"))).not.toThrow();
  });
});
