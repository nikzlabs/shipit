import { describe, it, expect, vi } from "vitest";
import { DIRECT_CALL_PATHS } from "../../shared/catalogue/index.js";
import { directCallForStyle, directCallStyles } from "./index.js";

describe("the client registry", () => {
  it("covers exactly the styles the catalogue declares a path for", () => {
    // A path with no client resolves selections to a URL nothing can call; a
    // client with no path has no declared join to use.
    expect(directCallStyles().sort()).toEqual(Object.keys(DIRECT_CALL_PATHS).sort());
  });

  it("has no client for a style outside that set", () => {
    expect(directCallForStyle("gemini-generate-content")).toBeUndefined();
  });

  it("builds a client on the injected fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 }),
    );
    const call = directCallForStyle("anthropic-messages", fetchImpl as unknown as typeof fetch);

    const result = await call!({
      baseUrl: "https://example.test",
      apiModelId: "m",
      apiKey: "k",
      prompt: "p",
      maxOutputChars: 100,
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("hi");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
