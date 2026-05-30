import { describe, it, expect, vi } from "vitest";
import { createDeepgramProvider } from "./deepgram.js";
import { VoiceProviderError } from "./types.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("createDeepgramProvider", () => {
  it("posts raw audio to the listen endpoint and returns the trimmed transcript", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okJson({ results: { channels: [{ alternatives: [{ transcript: "  hello world  " }] }] } }));
    const provider = createDeepgramProvider("dg-test", fetchImpl as unknown as typeof fetch);

    const text = await provider.transcribe(Buffer.from("audio"), { mimeType: "audio/webm" });

    expect(text).toBe("hello world");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url).startsWith("https://api.deepgram.com/v1/listen")).toBe(true);
    expect(String(url).includes("model=nova-2")).toBe(true);
    expect(String(url).includes("smart_format=true")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Token dg-test");
  });

  it("includes only the leading language subtag in the query", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ results: { channels: [{ alternatives: [{ transcript: "x" }] }] } }));
    const provider = createDeepgramProvider("dg-test", fetchImpl as unknown as typeof fetch);

    await provider.transcribe(Buffer.from("a"), { language: "en-US" });

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url.includes("language=en")).toBe(true);
    expect(url.includes("language=en-US")).toBe(false);
  });

  it("omits the language param when no language is given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ results: { channels: [{ alternatives: [{ transcript: "x" }] }] } }));
    const provider = createDeepgramProvider("dg-test", fetchImpl as unknown as typeof fetch);

    await provider.transcribe(Buffer.from("a"), {});

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url.includes("language=")).toBe(false);
  });

  it("returns an empty string when the transcript path is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ results: { channels: [] } }));
    const provider = createDeepgramProvider("dg-test", fetchImpl as unknown as typeof fetch);

    const text = await provider.transcribe(Buffer.from("a"), {});

    expect(text).toBe("");
  });

  it("throws VoiceProviderError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = createDeepgramProvider("dg-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.transcribe(Buffer.from("a"), {})).rejects.toBeInstanceOf(VoiceProviderError);
  });

  it("wraps network failures as a 502 VoiceProviderError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = createDeepgramProvider("dg-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.transcribe(Buffer.from("a"), {})).rejects.toMatchObject({ statusCode: 502 });
  });
});
