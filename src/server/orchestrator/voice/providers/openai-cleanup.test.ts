import { describe, it, expect, vi } from "vitest";
import { createOpenAiCleanupProvider } from "./openai-cleanup.js";
import { CLEANUP_INSTRUCTIONS } from "../cleanup-prompt.js";
import { VoiceProviderError } from "./types.js";

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createOpenAiCleanupProvider", () => {
  it("has the openai-cleanup id", () => {
    expect(createOpenAiCleanupProvider("k").id).toBe("openai-cleanup");
  });

  it("sends the locked prompt and returns the trimmed completion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("  Cleaned text  "));
    const provider = createOpenAiCleanupProvider("sk-test", fetchImpl as unknown as typeof fetch);

    const out = await provider.clean("um cleaned text", {});

    expect(out).toBe("Cleaned text");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("gpt-4o-mini");
    expect(sent.temperature).toBe(0);
    expect(sent.messages[0].content).toContain(CLEANUP_INSTRUCTIONS);
    expect(sent.messages[0].content).toContain("um cleaned text");
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("ok"));
    const provider = createOpenAiCleanupProvider("sk-test", fetchImpl as unknown as typeof fetch);
    const controller = new AbortController();

    await provider.clean("x", { signal: controller.signal });

    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("throws VoiceProviderError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("err", { status: 429 }));
    const provider = createOpenAiCleanupProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.clean("x", {})).rejects.toBeInstanceOf(VoiceProviderError);
  });
});
