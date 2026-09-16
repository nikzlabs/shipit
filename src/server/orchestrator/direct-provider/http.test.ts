import { describe, it, expect } from "vitest";
import { MAX_OUTPUT_TOKENS, postJson, requireCompleteText, uncachedInput } from "./http.js";
import { DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS } from "../../shared/sub-agent-run.js";
import { DirectCallError } from "./types.js";

function abortError(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

async function expectPostJsonError(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<DirectCallError> {
  try {
    await postJson(fetchImpl, "https://api.example/v1/messages", {}, {}, signal, "Style");
  } catch (err) {
    return err as DirectCallError;
  }
  throw new Error("expected a failure");
}

describe("MAX_OUTPUT_TOKENS", () => {
  // At one character per token — a real tokenizer's worst case — the flat cap
  // still covers the largest answer any caller collects, so it cannot be what
  // stops a call. Sizing it from the caller instead is what broke voice
  // cleanup: vendors bill reasoning against this same number.
  it("clears the largest collected answer even at one character per token", () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS);
    expect(Number.isInteger(MAX_OUTPUT_TOKENS)).toBe(true);
  });
});

describe("uncachedInput", () => {
  it("removes both cache portions from an inclusive total", () => {
    expect(uncachedInput(100, 60, 20)).toBe(20);
  });

  it("stays undefined when the provider reported no total", () => {
    // A zero would assert a free run, which is not what silence means.
    expect(uncachedInput(undefined, 60, 20)).toBeUndefined();
  });

  it("never goes negative on an inconsistent report", () => {
    expect(uncachedInput(10, 60, 20)).toBe(0);
  });
});

/**
 * A call cut off before its body could be read may have been billed by a
 * provider that will never say how much, because these styles report usage only
 * in a whole body (docs/299-direct-provider-calls req 7). `spendUnknown` is what
 * lets the caller record the run anyway, so it must separate the failures that
 * could have cost money from the ones that could not.
 */
describe("postJson — a call whose amount can no longer be read", () => {
  it("marks a cancellation that fired after the request was handed over", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      throw abortError();
    }) as unknown as typeof fetch;

    const err = await expectPostJsonError(fetchImpl, controller.signal);
    expect(err).toBeInstanceOf(DirectCallError);
    expect(err.spendUnknown).toBe(true);
    expect(err.usage).toBeUndefined();
  });

  // Measured: with the headers already received, the abort rejects the body read
  // instead. Before this, that rejection escaped as a raw AbortError and reached
  // no failure path at all.
  it("marks an abort that fired while the body was still arriving", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      return new Response(
        new ReadableStream({ start: (c) => c.error(abortError()) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    expect((await expectPostJsonError(fetchImpl, controller.signal)).spendUnknown).toBe(true);
  });

  // The provider answered 200 and was writing the answer when the socket died —
  // nobody cancelled anything, and the run was billed just the same. Measured as
  // a TypeError (UND_ERR_SOCKET) out of `res.json()`.
  it("marks a body lost to a dropped socket, with no cancellation involved", async () => {
    const fetchImpl = (async () => new Response(
      new ReadableStream({
        start: (c) => {
          c.enqueue(new TextEncoder().encode('{"content":[{"type":"text"'));
          c.error(new TypeError("terminated"));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

    const err = await expectPostJsonError(fetchImpl, new AbortController().signal);
    expect(err).toBeInstanceOf(DirectCallError);
    expect(err.spendUnknown).toBe(true);
  });

  it("does not mark a cancellation that had already fired before the request went out", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async () => {
      throw abortError();
    }) as unknown as typeof fetch;

    expect((await expectPostJsonError(fetchImpl, controller.signal)).spendUnknown).toBe(false);
  });

  it("does not mark a transport failure that was nobody's deadline", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    expect((await expectPostJsonError(fetchImpl, new AbortController().signal)).spendUnknown).toBe(false);
  });

  // The whole body arrived, so it was read to the end and no model wrote it —
  // a gateway's error page, not a billed generation.
  it("does not mark a body that arrived complete and was simply not JSON", async () => {
    const fetchImpl = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;

    const err = await expectPostJsonError(fetchImpl, new AbortController().signal);
    expect(err).toBeInstanceOf(DirectCallError);
    expect(err.spendUnknown).toBe(false);
  });
});

describe("requireCompleteText", () => {
  it("passes text through", () => {
    expect(requireCompleteText("answer", "Style")).toBe("answer");
  });

  it("turns an empty answer into an error naming why it stopped", () => {
    expect(() => requireCompleteText("", "Style", "max_tokens")).toThrow(DirectCallError);
    expect(() => requireCompleteText("", "Style", "max_tokens")).toThrow(/max_tokens/);
  });

  // A partial answer reads exactly like a complete one, so accepting it would
  // replace a dictation with its own opening clause and say nothing.
  it("rejects a partial answer the provider stopped on its output limit", () => {
    expect(() => requireCompleteText("Rename the file", "Style", "max_tokens"))
      .toThrow(/output budget/);
    expect(() => requireCompleteText("Rename the file", "Style", "length"))
      .toThrow(/output budget/);
  });

  it("keeps the counts on the error, because the partial answer was billed", () => {
    try {
      requireCompleteText("Rename the file", "Style", "length", { inputTokens: 90, outputTokens: 12 });
      throw new Error("expected a failure");
    } catch (err) {
      expect((err as DirectCallError).usage).toEqual({ inputTokens: 90, outputTokens: 12 });
    }
  });

  it("passes an ordinary stop reason through", () => {
    expect(requireCompleteText("answer", "Style", "stop")).toBe("answer");
    expect(requireCompleteText("answer", "Style", "end_turn")).toBe("answer");
    expect(requireCompleteText("answer", "Style", "completed")).toBe("answer");
  });
});
