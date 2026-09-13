import { describe, it, expect, vi } from "vitest";
import { directCallSelections } from "../../shared/catalogue/index.js";
import { createOpenAiChatCompletionsCall } from "./openai-chat-completions.js";
import { DirectCallError } from "./types.js";

// Real shipped rows: OpenCode Go is reached through this style, and Go is the
// service that answers an unnamed client with an error rather than a completion.
const ROWS = directCallSelections()
  .filter((entry) => entry.target.style === "openai-chat-completions")
  .map((entry) => [`${entry.selection.serviceId}/${entry.selection.modelId}`, entry] as const);

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 22,
        prompt_tokens_details: { cached_tokens: 33 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function callWith(fetchImpl: ReturnType<typeof vi.fn>, entry: (typeof ROWS)[number][1]) {
  return createOpenAiChatCompletionsCall(fetchImpl as unknown as typeof fetch)({
    baseUrl: entry.target.baseUrl,
    apiModelId: entry.target.apiModelId,
    apiKey: "test-key",
    ...(entry.target.headers ? { headers: entry.target.headers } : {}),
    prompt: "clean this",
    maxOutputChars: 1200,
    signal: new AbortController().signal,
  });
}

describe("createOpenAiChatCompletionsCall against shipped catalogue rows", () => {
  it.each(ROWS)("%s posts to its own base with its own API model id", async (_name, entry) => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("ok"));

    await callWith(fetchImpl, entry);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${entry.target.baseUrl}/chat/completions`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(entry.target.apiModelId);
    if (entry.target.apiModelId !== entry.selection.modelId) {
      expect(sent.model).not.toBe(entry.selection.modelId);
    }
    expect(init.headers.Authorization).toBe("Bearer test-key");
    for (const [name, value] of Object.entries(entry.target.headers ?? {})) {
      expect(init.headers[name]).toBe(value);
    }
    expect(sent.max_tokens).toBeGreaterThanOrEqual(1200 / 4);
  });

  it("sends every header a shipped credential declares", () => {
    // Nothing here declares headers for its own sake: a service that refuses a
    // generic client must have them on the wire, so at least one row carries some.
    const declared = ROWS.filter(([, entry]) => entry.target.headers !== undefined);
    expect(declared.length).toBeGreaterThan(0);
  });
});

describe("createOpenAiChatCompletionsCall", () => {
  const base = ROWS[0][1];

  it("returns the trimmed completion and the cached input count", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("  Cleaned  "));

    const result = await callWith(fetchImpl, base);

    expect(result.text).toBe("Cleaned");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(22);
    expect(result.cacheReadTokens).toBe(33);
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("ok"));
    const controller = new AbortController();

    await createOpenAiChatCompletionsCall(fetchImpl as unknown as typeof fetch)({
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
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      status: 403,
    });
  });

  it("reports a transport failure as a gateway error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(callWith(fetchImpl, base)).rejects.toBeInstanceOf(DirectCallError);
  });
});
