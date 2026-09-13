import { describe, it, expect } from "vitest";
import { directCallPathFor, directCallSelections, joinEndpoint, resolveDirectCall } from "./index.js";

/**
 * Independent evidence, written here rather than read from the catalogue: a
 * test that derives its expectation from the resolver it is testing cannot fail
 * when a base URL or a declaration drifts, because both sides move together.
 *
 * Every URL below was probed on 2026-09-13 and answered an authentication
 * error, not a 404 — so the route exists. A row that goes red here means a
 * service's endpoint or its terms declaration changed: check the vendor, then
 * change this table deliberately.
 */
const EXPECTED: Record<string, { style: string; url: string; headers?: string[] }> = {
  "anthropic/key": { style: "anthropic-messages", url: "https://api.anthropic.com/v1/messages" },
  "openai/key": { style: "openai-responses", url: "https://api.openai.com/v1/responses" },
  "xai/key": { style: "openai-responses", url: "https://api.x.ai/v1/responses" },
  "deepseek/key": {
    style: "anthropic-messages",
    url: "https://api.deepseek.com/anthropic/v1/messages",
  },
  "zai/key": { style: "anthropic-messages", url: "https://api.z.ai/api/anthropic/v1/messages" },
  "openrouter/key": { style: "anthropic-messages", url: "https://openrouter.ai/api/v1/messages" },
  "vercel/key": { style: "anthropic-messages", url: "https://ai-gateway.vercel.sh/v1/messages" },
  "opencode/key": { style: "anthropic-messages", url: "https://opencode.ai/zen/v1/messages" },
  "opencode/sub": {
    style: "openai-chat-completions",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    headers: ["User-Agent", "x-opencode-session"],
  },
};

function modeKey(entry: { selection: { serviceId: string; billingMode: string } }): string {
  return `${entry.selection.serviceId}/${entry.selection.billingMode}`;
}

describe("which credentials are callable at all", () => {
  it("is exactly the authored set", () => {
    // A new entry here is a terms decision, so adding one must be deliberate.
    // google/key is absent on purpose: its key permits a direct call, but no
    // client speaks its style, so no selection of it resolves.
    const modes = [...new Set(directCallSelections().map(modeKey))].sort();
    expect(modes).toEqual(Object.keys(EXPECTED).sort());
  });

  it("no subscription other than OpenCode Go is callable", () => {
    const subs = [...new Set(directCallSelections().filter((e) => e.selection.billingMode === "sub").map(modeKey))];
    expect(subs).toEqual(["opencode/sub"]);
  });
});

describe("what each callable credential resolves to", () => {
  it.each(Object.keys(EXPECTED))("%s reaches its probed URL", (key) => {
    const entries = directCallSelections().filter((entry) => modeKey(entry) === key);
    expect(entries.length).toBeGreaterThan(0);
    const expected = EXPECTED[key];
    // Several models of one mode may take different styles; the mode's primary
    // style is the one its first model resolves to.
    const first = entries[0];
    expect(first.target.style).toBe(expected.style);
    expect(joinEndpoint(first.target.baseUrl, directCallPathFor(first.target.style)!)).toBe(
      expected.url,
    );
    expect(Object.keys(first.target.headers ?? {}).sort()).toEqual([...(expected.headers ?? [])].sort());
  });

  it("Anthropic's Haiku row sends the vendor id, not the harness alias", () => {
    // The founding case for apiId, pinned independently of the row: the id a
    // harness takes on its command line is not the id the API takes.
    const target = resolveDirectCall({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "haiku",
    });
    expect(target?.apiModelId).toBe("claude-haiku-4-5");
  });
});

describe("a conversation header identifies one conversation", () => {
  it("is minted fresh per resolution", () => {
    const of = () =>
      resolveDirectCall({ serviceId: "opencode", billingMode: "sub", modelId: "glm-5.2" })?.headers?.[
        "x-opencode-session"
      ];
    const first = of();
    expect(first).toBeTruthy();
    expect(of()).not.toBe(first);
  });

  it("does not disturb the credential's fixed headers", () => {
    const target = resolveDirectCall({ serviceId: "opencode", billingMode: "sub", modelId: "glm-5.2" });
    expect(target?.headers?.["User-Agent"]).toBe("ShipIt");
  });
});
