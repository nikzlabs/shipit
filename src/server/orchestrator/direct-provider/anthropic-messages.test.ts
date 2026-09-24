import { describe, it, expect, vi } from "vitest";
import { directCallSelections } from "../../shared/catalogue/index.js";
import { createAnthropicMessagesCall } from "./anthropic-messages.js";
import { MAX_OUTPUT_TOKENS } from "./http.js";
import { DirectCallError } from "./types.js";

// Real shipped rows, not a hand-written fixture: a request shape assertion
// alone would pass while sending a harness alias to a base that never carries
// this style (docs/299). The URLs those rows must produce are pinned
// independently in `catalogue/direct-call-contract.test.ts`.
const ROWS = directCallSelections()
  .filter((entry) => entry.target.style === "anthropic-messages")
  .map((entry) => [`${entry.selection.serviceId}/${entry.selection.modelId}`, entry] as const);

// This style reports the three input figures disjointly: 20 uncached, 60 read
// from cache, 20 written to it.
function messagesResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "thinking", text: "ignored" }, { type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 20,
        output_tokens: 15,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 20,
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
    expect(sent.messages).toEqual([{ role: "user", content: "clean this" }]);
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBeTruthy();
    for (const [name, value] of Object.entries(entry.target.headers ?? {})) {
      expect(init.headers[name]).toBe(value);
    }
    // Required by the API, so a number must be sent; it is a runaway stop and
    // not a budget, which is why it is flat rather than sized from the prompt.
    expect(sent.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });
});

describe("createAnthropicMessagesCall", () => {
  const base = ROWS[0][1];

  it("returns the joined text and keeps the three input counts disjoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse("  Cleaned  "));

    const result = await callWith(fetchImpl, base);

    expect(result.text).toBe("Cleaned");
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(15);
    expect(result.cacheReadTokens).toBe(60);
    expect(result.cacheCreateTokens).toBe(20);
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messagesResponse("ok"));
    const controller = new AbortController();

    await createAnthropicMessagesCall(fetchImpl as unknown as typeof fetch)({
      baseUrl: base.target.baseUrl,
      apiModelId: base.target.apiModelId,
      apiKey: "k",
      prompt: "p",
      signal: controller.signal,
    });

    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("fails on an answer that stopped before writing any text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [], stop_reason: "max_tokens" }), { status: 200 }),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      message: expect.stringContaining("max_tokens"),
    });
  });

  // A provider whose own limit is below the flat cap still answers 200 with
  // real text that stops part-way, which reads exactly like a complete answer.
  // The cap was never the protection against that; this check is.
  it("still fails on a 200 whose text stopped on the provider's own output limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Rename the file and then" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 20, output_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      message: expect.stringContaining("output budget"),
    });
  });

  it("carries what a textless answer was billed", async () => {
    // The tokens were spent; a caller that dropped them would lose real money
    // from every total (docs/299 req 7).
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [],
          stop_reason: "max_tokens",
          usage: { input_tokens: 20, output_tokens: 900, cache_read_input_tokens: 60 },
        }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      usage: { inputTokens: 20, outputTokens: 900, cacheReadTokens: 60 },
    });
  });

  it("reports the provider's status on a refusal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 429 }));

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      status: 429,
    });
  });

  it("treats a block shape the API forbids as a billed failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [null], usage: { input_tokens: 100, output_tokens: 900 } }),
        { status: 200 },
      ),
    );

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({
      name: "DirectCallError",
      usage: { inputTokens: 100, outputTokens: 900 },
    });
  });

  it("carries no counts when the request never reached a response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 429 }));

    await expect(callWith(fetchImpl, base)).rejects.toMatchObject({ usage: undefined });
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
      signal: new AbortController().signal,
    });

    expect(fetchImpl.mock.calls[0][1].headers["anthropic-version"]).toBe("9999-01-01");
  });

  it("sends output_config.effort only when the request carries one", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => messagesResponse("ok"));
    const call = createAnthropicMessagesCall(fetchImpl as unknown as typeof fetch);
    const req = {
      baseUrl: base.target.baseUrl,
      apiModelId: base.target.apiModelId,
      apiKey: "k",
      prompt: "p",
      signal: new AbortController().signal,
    };

    await call(req);
    await call({ ...req, effort: "low" });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty("output_config");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).output_config).toEqual({ effort: "low" });
  });
});
