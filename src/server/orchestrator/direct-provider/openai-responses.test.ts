import { describe, it, expect, vi } from "vitest";
import { directCallSelections } from "../../shared/catalogue/index.js";
import { createOpenAiResponsesCall } from "./openai-responses.js";
import { DirectCallError } from "./types.js";

const ROWS = directCallSelections()
  .filter((entry) => entry.target.style === "openai-responses")
  .map((entry) => [`${entry.selection.serviceId}/${entry.selection.modelId}`, entry] as const);

function responsesResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "ignored" }] },
        { type: "message", content: [{ type: "output_text", text }] },
      ],
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        input_tokens_details: { cached_tokens: 33 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function callWith(fetchImpl: ReturnType<typeof vi.fn>, entry: (typeof ROWS)[number][1]) {
  return createOpenAiResponsesCall(fetchImpl as unknown as typeof fetch)({
    baseUrl: entry.target.baseUrl,
    apiModelId: entry.target.apiModelId,
    apiKey: "test-key",
    ...(entry.target.headers ? { headers: entry.target.headers } : {}),
    prompt: "clean this",
    maxOutputChars: 1200,
    signal: new AbortController().signal,
  });
}

describe("createOpenAiResponsesCall against shipped catalogue rows", () => {
  it.each(ROWS)("%s posts to its own base with its own API model id", async (_name, entry) => {
    const fetchImpl = vi.fn().mockResolvedValue(responsesResponse("ok"));

    await callWith(fetchImpl, entry);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${entry.target.baseUrl}/responses`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(entry.target.apiModelId);
    if (entry.target.apiModelId !== entry.selection.modelId) {
      expect(sent.model).not.toBe(entry.selection.modelId);
    }
    expect(init.headers.Authorization).toBe("Bearer test-key");
    for (const [name, value] of Object.entries(entry.target.headers ?? {})) {
      expect(init.headers[name]).toBe(value);
    }
    expect(sent.max_output_tokens).toBeGreaterThanOrEqual(1200 / 4);
  });
});

describe("createOpenAiResponsesCall", () => {
  const base = ROWS[0][1];

  it("reads the message item and ignores the reasoning item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responsesResponse("  Cleaned  "));

    const result = await callWith(fetchImpl, base);

    expect(result.text).toBe("Cleaned");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(22);
    expect(result.cacheReadTokens).toBe(33);
    expect(result.cacheCreateTokens).toBeUndefined();
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responsesResponse("ok"));
    const controller = new AbortController();

    await createOpenAiResponsesCall(fetchImpl as unknown as typeof fetch)({
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
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      status: 400,
    });
  });

  it("reports a transport failure as a gateway error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(callWith(fetchImpl, base)).rejects.toBeInstanceOf(DirectCallError);
  });
});
