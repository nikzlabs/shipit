import { describe, it, expect, vi } from "vitest";
import { pickCleanupProvider, cleanTranscript } from "./cleanup.js";
import type { CleanupProvider } from "./providers/types.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";

function authStub(token: string | null): AuthManager {
  return {
    getAccessToken: vi.fn().mockResolvedValue({ token }),
  } as unknown as AuthManager;
}

function authThrows(): AuthManager {
  return {
    getAccessToken: vi.fn().mockRejectedValue(new Error("oauth broken")),
  } as unknown as AuthManager;
}

describe("pickCleanupProvider", () => {
  it("prefers the Claude OAuth bearer when present", async () => {
    const provider = await pickCleanupProvider(authStub("oauth-token"), "openai-key");
    expect(provider?.id).toBe("claude-oauth");
  });

  it("falls back to OpenAI when no OAuth bearer", async () => {
    const provider = await pickCleanupProvider(authStub(null), "openai-key");
    expect(provider?.id).toBe("openai-cleanup");
  });

  it("falls back to OpenAI when the OAuth lookup throws", async () => {
    const provider = await pickCleanupProvider(authThrows(), "openai-key");
    expect(provider?.id).toBe("openai-cleanup");
  });

  it("returns null when neither path is available", async () => {
    expect(await pickCleanupProvider(authStub(null), null)).toBeNull();
  });
});

function fakeProvider(impl: (raw: string) => Promise<string> | string): CleanupProvider {
  return {
    id: "claude-oauth",
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
    expect(r.cleanupProvider).toBe("claude-oauth");
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

  it("falls through to raw with timeout code on abort", async () => {
    const provider = fakeProvider(
      () =>
        new Promise<string>((_resolve, reject) => {
          // Never resolves before the timeout; reject as the abort would.
          setTimeout(() => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          }, 5);
        }),
    );
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
