import { describe, it, expect, vi } from "vitest";
import { DIRECT_CALL_PATHS } from "../../shared/catalogue/index.js";
import { directCallForStyle, directCallStyles } from "./index.js";
import type { ApiStyle } from "../../shared/catalogue/index.js";

// One 200 that every style's parser can read, so the only thing that varies is
// which client the registry chose.
const ANY_STYLE_BODY = {
  content: [{ type: "text", text: "hi" }],
  choices: [{ message: { content: "hi" } }],
  output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
};

describe("the client registry", () => {
  it("covers exactly the styles the catalogue declares a path for", () => {
    // A path with no client resolves selections to a URL nothing can call; a
    // client with no path has no declared join to use.
    expect(directCallStyles().sort()).toEqual(Object.keys(DIRECT_CALL_PATHS).sort());
  });

  it("has no client for a style outside that set", () => {
    expect(directCallForStyle("gemini-generate-content")).toBeUndefined();
  });

  it.each(Object.entries(DIRECT_CALL_PATHS))(
    "%s is wired to the client that posts to %s",
    async (style, path) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(ANY_STYLE_BODY), { status: 200 }));

      const result = await directCallForStyle(style as ApiStyle, fetchImpl as unknown as typeof fetch)!({
        baseUrl: "https://example.test",
        apiModelId: "m",
        apiKey: "k",
        prompt: "p",
        signal: new AbortController().signal,
      });

      expect(result.text).toBe("hi");
      expect(fetchImpl.mock.calls[0][0]).toBe(`https://example.test${path}`);
    },
  );
});
