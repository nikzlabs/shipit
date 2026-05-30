import { describe, it, expect, vi } from "vitest";
import { createClaudeCleanupProvider } from "./claude-cleanup.js";
import { CLEANUP_INSTRUCTIONS } from "../cleanup-prompt.js";
import { VoiceProviderError } from "./types.js";

function messagesResponse(blocks: { type: string; text?: string }[]): Response {
  return new Response(JSON.stringify({ content: blocks }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createClaudeCleanupProvider", () => {
  it("has the claude-oauth id", () => {
    expect(createClaudeCleanupProvider("t").id).toBe("claude-oauth");
  });

  it("sends OAuth identity headers and the locked prompt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse([{ type: "text", text: "Cleaned." }]));
    const provider = createClaudeCleanupProvider("oauth-token", fetchImpl as unknown as typeof fetch);

    const out = await provider.clean("um cleaned", {});

    expect(out).toBe("Cleaned.");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers.Authorization).toBe("Bearer oauth-token");
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("claude-haiku-4-5");
    expect(sent.system).toContain("Claude Code");
    expect(sent.messages[0].content).toContain(CLEANUP_INSTRUCTIONS);
  });

  it("joins only text content blocks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      messagesResponse([
        { type: "text", text: "Hello " },
        { type: "tool_use" },
        { type: "text", text: "world" },
      ]),
    );
    const provider = createClaudeCleanupProvider("t", fetchImpl as unknown as typeof fetch);

    expect(await provider.clean("x", {})).toBe("Hello world");
  });

  it("throws VoiceProviderError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    const provider = createClaudeCleanupProvider("t", fetchImpl as unknown as typeof fetch);

    await expect(provider.clean("x", {})).rejects.toBeInstanceOf(VoiceProviderError);
  });
});
