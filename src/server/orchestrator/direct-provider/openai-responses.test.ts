import { describe, it, expect, vi } from "vitest";
import { directCallSelections } from "../../shared/catalogue/index.js";
import { createOpenAiResponsesCall } from "./openai-responses.js";
import { MAX_OUTPUT_TOKENS } from "./http.js";
import { DirectCallError } from "./types.js";

const ROWS = directCallSelections()
  .filter((entry) => entry.target.style === "openai-responses")
  .map((entry) => [`${entry.selection.serviceId}/${entry.selection.modelId}`, entry] as const);

// This style reports an input TOTAL that includes its cached portion: 100 in
// all, of which 60 were read from cache and 20 written to it.
function responsesResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "ignored" }] },
        { type: "message", content: [{ type: "output_text", text }] },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 15,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
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
    expect(sent.input).toBe("clean this");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    for (const [name, value] of Object.entries(entry.target.headers ?? {})) {
      expect(init.headers[name]).toBe(value);
    }
    // Reasoning is billed against this same cap, which is why it is flat and
    // generous rather than sized from the answer a caller would accept.
    expect(sent.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
  });
});

describe("createOpenAiResponsesCall", () => {
  const base = ROWS[0][1];

  it("reads the message item, ignores reasoning, and subtracts the cached portion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responsesResponse("  Cleaned  "));

    const result = await callWith(fetchImpl, base);

    expect(result.text).toBe("Cleaned");
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(15);
    expect(result.cacheReadTokens).toBe(60);
    expect(result.cacheCreateTokens).toBe(20);
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responsesResponse("ok"));
    const controller = new AbortController();

    await createOpenAiResponsesCall(fetchImpl as unknown as typeof fetch)({
      baseUrl: base.target.baseUrl,
      apiModelId: base.target.apiModelId,
      apiKey: "k",
      prompt: "p",
      signal: controller.signal,
    });

    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("fails on a run that spent its budget on reasoning", async () => {
    // The documented failure: HTTP 200, a reasoning item, no answer.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "reasoning", content: [] }],
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      message: expect.stringContaining("max_output_tokens"),
    });
  });

  it("fails on a run that stopped early even when it wrote partial text", async () => {
    // Partial text is indistinguishable from a short complete answer.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "incomplete",
          output: [{ type: "message", content: [{ type: "output_text", text: "half an ans" }] }],
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toBeInstanceOf(DirectCallError);
  });

  it("carries what a run that spent its budget on reasoning was billed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "reasoning", content: [] }],
          usage: {
            input_tokens: 100,
            output_tokens: 6763,
            input_tokens_details: { cached_tokens: 60 },
          },
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      usage: { inputTokens: 40, outputTokens: 6763, cacheReadTokens: 60 },
    });
  });

  it("carries what a completed run that wrote no message item was billed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "reasoning", content: [] }],
          usage: { input_tokens: 100, output_tokens: 900 },
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      usage: { inputTokens: 100, outputTokens: 900 },
    });
  });

  it("fails on a completed run that wrote no message item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "completed", output: [{ type: "reasoning", content: [] }] }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toBeInstanceOf(DirectCallError);
  });

  it("treats an output shape the API forbids as a billed failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [null],
          usage: { input_tokens: 100, output_tokens: 900 },
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      usage: { inputTokens: 100, outputTokens: 900 },
    });
  });

  it("accepts a gateway that reports no status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).resolves.toMatchObject({ text: "ok" });
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
