import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TtsCache, ttsCacheKey } from "./tts-cache.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-cache-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ttsCacheKey", () => {
  it("is stable for identical inputs", () => {
    expect(ttsCacheKey("hi", "nova", 1, "openai")).toBe(ttsCacheKey("hi", "nova", 1, "openai"));
  });

  it("varies by text, voice, speed, and provider", () => {
    const base = ttsCacheKey("hi", "nova", 1, "openai");
    expect(ttsCacheKey("bye", "nova", 1, "openai")).not.toBe(base);
    expect(ttsCacheKey("hi", "alloy", 1, "openai")).not.toBe(base);
    expect(ttsCacheKey("hi", "nova", 2, "openai")).not.toBe(base);
    expect(ttsCacheKey("hi", "nova", 1, "claude")).not.toBe(base);
  });
});

describe("TtsCache", () => {
  it("returns null for a missing key", () => {
    const cache = new TtsCache(dir);
    expect(cache.get("nope")).toBeNull();
  });

  it("stores and retrieves audio bytes", () => {
    const cache = new TtsCache(dir);
    const data = Buffer.from([1, 2, 3, 4]);
    cache.set("k1", data);
    expect(cache.get("k1")).toEqual(data);
    expect(cache.sizeBytes).toBe(4);
  });

  it("rebuilds its index from disk on construction", () => {
    const first = new TtsCache(dir);
    first.set("k1", Buffer.from([1, 2, 3]));

    const second = new TtsCache(dir);
    expect(second.get("k1")).toEqual(Buffer.from([1, 2, 3]));
    expect(second.sizeBytes).toBe(3);
  });

  it("evicts least-recently-used entries past the byte cap", () => {
    const cache = new TtsCache(dir, 10);
    cache.set("a", Buffer.alloc(6, 1));
    cache.set("b", Buffer.alloc(6, 2)); // total 12 > 10 → evict LRU "a"

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.sizeBytes).toBeLessThanOrEqual(10);
  });

  it("drops the index entry when the file vanishes underneath it", () => {
    const cache = new TtsCache(dir);
    cache.set("k1", Buffer.from([9]));
    fs.rmSync(path.join(dir, "k1.bin"));
    expect(cache.get("k1")).toBeNull();
  });
});
