import { describe, it, expect } from "vitest";
import { pickCleanupProvider, cleanTranscript } from "./cleanup.js";
import type { CleanupProvider } from "./providers/types.js";

describe("pickCleanupProvider", () => {
  it("uses the OpenAI voice key", () => {
    expect(pickCleanupProvider("openai-key")?.id).toBe("openai-cleanup");
  });

  it("returns null without one", () => {
    expect(pickCleanupProvider(null)).toBeNull();
  });
});

function fakeProvider(impl: (raw: string) => Promise<string> | string): CleanupProvider {
  return {
    id: "openai-cleanup",
    clean: async (raw) => impl(raw),
  };
}

describe("cleanTranscript", () => {
  it("returns no-provider error when provider is null", async () => {
    const r = await cleanTranscript("hello", null);
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("no-provider");
    expect(r.cleanupProvider).toBeUndefined();
  });

  it("returns the cleaned text on success", async () => {
    const r = await cleanTranscript("um hello", fakeProvider(() => "Hello"));
    expect(r.text).toBe("Hello");
    expect(r.cleanupProvider).toBe("openai-cleanup");
    expect(r.cleanupErrorCode).toBeUndefined();
  });

  it("falls through to raw on empty output", async () => {
    const r = await cleanTranscript("hello", fakeProvider(() => ""));
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("empty-output");
  });

  it("falls through to raw when output is implausibly long", async () => {
    const r = await cleanTranscript("hi", fakeProvider(() => "x".repeat(200)));
    expect(r.text).toBe("hi");
    expect(r.cleanupErrorCode).toBe("too-long");
  });

  it("falls through to raw when output has a preamble", async () => {
    const r = await cleanTranscript("hello", fakeProvider(() => "Here is the cleaned message: hello"));
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("preamble");
  });

  // The provider aborts only when cleanTranscript's own timer fires, so
  // dropping that timer makes this resolve with the cleaned text instead.
  it("falls through to raw with timeout code when the deadline fires", async () => {
    const provider: CleanupProvider = {
      id: "openai-cleanup",
      clean: (_raw, opts) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve("Answered in time"), 500);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    };
    const r = await cleanTranscript("hello", provider, { timeoutMs: 1 });
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("timeout");
  });

  it("falls through to raw with provider-error on other failures", async () => {
    const r = await cleanTranscript(
      "hello",
      fakeProvider(() => {
        throw new Error("500");
      }),
    );
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("provider-error");
  });
});
