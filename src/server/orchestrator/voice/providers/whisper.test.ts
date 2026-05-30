import { describe, it, expect, vi } from "vitest";
import { createWhisperProvider } from "./whisper.js";
import { VoiceProviderError } from "./types.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("createWhisperProvider", () => {
  it("posts multipart audio and returns the trimmed transcript", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ text: "  hello world  " }));
    const provider = createWhisperProvider("sk-test", fetchImpl as unknown as typeof fetch);

    const text = await provider.transcribe(Buffer.from("audio"), { mimeType: "audio/webm" });

    expect(text).toBe("hello world");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("model")).toBe("whisper-1");
  });

  it("passes only the leading language subtag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ text: "x" }));
    const provider = createWhisperProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await provider.transcribe(Buffer.from("a"), { language: "en-US" });

    const form = fetchImpl.mock.calls[0][1].body as FormData;
    expect(form.get("language")).toBe("en");
  });

  it("throws VoiceProviderError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = createWhisperProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.transcribe(Buffer.from("a"), {})).rejects.toBeInstanceOf(VoiceProviderError);
  });

  it("wraps network failures as a 502 VoiceProviderError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = createWhisperProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.transcribe(Buffer.from("a"), {})).rejects.toMatchObject({ statusCode: 502 });
  });
});
