import { describe, it, expect, vi } from "vitest";
import { directCallSelections } from "../../shared/catalogue/index.js";
import { createAnthropicMessagesCall } from "./anthropic-messages.js";
import { DirectCallError } from "./types.js";

// Real shipped rows, not a hand-written fixture: a request shape assertion
// alone would pass while sending a harness alias to a base that never carries
// this style (docs/299).
const ROWS = directCallSelections()
  .filter((entry) => entry.target.style === "anthropic-messages")
  .map((entry) => [`${entry.selection.serviceId}/${entry.selection.modelId}`, entry] as const);

function messagesResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "thinking", text: "ignored" }, { type: "text", text }],
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_read_input_tokens: 33,
        cache_creation_input_tokens: 44,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function callWith(fetchImpl: ReturnType<typeof vi.fn>, entry: (typeof ROWS)[number][1]) {
  return createAnthropicMessagesCall(fetchImpl as unknown as typeof fetch)({
    baseUrl: entry.target.baseUrl,
    apiModelId: entry.target.apiModelId,
    apiKey: "test-key",
    ...(entry.target.headers ? { headers: entry.target.headers } : {}),
    prompt: "clean this",
    maxOutputChars: 1200,
    signal: new AbortController().signal,
  });
}

describe("createAnthropicMessagesCall against shipped catalogue rows", () => {
  it.each(ROWS)("%s posts to its own base with its own API model id", async (_name, entry) => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse("ok"));

    await callWith(fetchImpl, entry);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${entry.target.baseUrl}/v1/messages`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(entry.target.apiModelId);
    if (entry.target.apiModelId !== entry.selection.modelId) {
      expect(sent.model).not.toBe(entry.selection.modelId);
    }
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBeTruthy();
    for (const [name, value] of Object.entries(entry.target.headers ?? {})) {
      expect(init.headers[name]).toBe(value);
    }
    expect(sent.max_tokens).toBeGreaterThanOrEqual(1200 / 4);
  });
});

describe("createAnthropicMessagesCall", () => {
  const base = ROWS[0][1];

  it("returns the joined text and counts cache reads apart from cache writes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse("  Cleaned  "));

    const result = await callWith(fetchImpl, base);

    expect(result.text).toBe("Cleaned");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(22);
    expect(result.cacheReadTokens).toBe(33);
    expect(result.cacheCreateTokens).toBe(44);
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse("ok"));
    const controller = new AbortController();

    await createAnthropicMessagesCall(fetchImpl as unknown as typeof fetch)({
      baseUrl: base.target.baseUrl,
      apiModelId: base.target.apiModelId,
      apiKey: "k",
      prompt: "p",
      maxOutputChars: 100,
      signal: controller.signal,
    });

    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("reports the provider's status on a refusal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 429 }));

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      status: 429,
    });
  });

  it("reports a transport failure as a gateway error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(callWith(fetchImpl, base)).rejects.toBeInstanceOf(DirectCallError);
  });

  it("lets a credential header override the client's own", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse("ok"));

    await createAnthropicMessagesCall(fetchImpl as unknown as typeof fetch)({
      baseUrl: base.target.baseUrl,
      apiModelId: base.target.apiModelId,
      apiKey: "k",
      headers: { "anthropic-version": "9999-01-01" },
      prompt: "p",
      maxOutputChars: 100,
      signal: new AbortController().signal,
    });

    expect(fetchImpl.mock.calls[0][1].headers["anthropic-version"]).toBe("9999-01-01");
  });
});
