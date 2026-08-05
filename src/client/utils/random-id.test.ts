import { describe, expect, it, afterEach, vi } from "vitest";
import { randomId } from "./random-id.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Reproduces the insecure-context environment: `crypto` exists, but the
 * secure-context-only `randomUUID` does not. This is exactly what a browser
 * hands a page served over plain HTTP from a non-localhost origin.
 */
function stubInsecureContextCrypto(): void {
  vi.stubGlobal("crypto", {
    getRandomValues: <T extends ArrayBufferView>(arr: T): T => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
      return arr;
    },
  });
}

describe("randomId", () => {
  it("returns a uuid shape when crypto.randomUUID is available", () => {
    expect(randomId()).toMatch(UUID_SHAPE);
  });

  it("does not throw when crypto.randomUUID is missing (plain-HTTP origin)", () => {
    stubInsecureContextCrypto();
    expect(() => randomId()).not.toThrow();
    expect(randomId()).toMatch(UUID_SHAPE);
  });

  it("falls back again when crypto itself is unusable", () => {
    vi.stubGlobal("crypto", {});
    expect(() => randomId()).not.toThrow();
    expect(randomId().length).toBeGreaterThan(0);
  });

  it("produces distinct ids across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomId()));
    expect(ids.size).toBe(50);
  });
});
