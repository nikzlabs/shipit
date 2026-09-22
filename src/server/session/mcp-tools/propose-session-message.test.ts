import { describe, it, expect, vi, afterEach } from "vitest";
import { proposeSessionMessageTool } from "./propose-session-message.js";

const deps = { workerUrl: "http://worker.test", sleep: async () => {} };

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const valid = { sessionId: "ses_root", message: "docs/314 is implemented." };

describe("propose_session_message", () => {
  it("posts the validated proposal to the worker", async () => {
    const fetchFn = stubFetch(200, { ok: true, cardId: "smp-1", targetTitle: "Orchestrator" });

    const out = await proposeSessionMessageTool.call(valid, deps);

    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Orchestrator");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://worker.test/agent-ops/propose-session-message",
      expect.objectContaining({ method: "POST", body: JSON.stringify(valid) }),
    );
  });

  // req 8 — a bad address fails back to the AGENT, which can still fix it.
  it("returns the server's refusal as a tool error, without a card", async () => {
    stubFetch(400, { error: "That is this session." });

    const out = await proposeSessionMessageTool.call(valid, deps);

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("That is this session.");
  });

  it("refuses locally before any request when a field is missing", async () => {
    const fetchFn = stubFetch(200, {});

    const out = await proposeSessionMessageTool.call({ sessionId: "ses_root" }, deps);

    expect(out.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports an unreachable worker rather than claiming a card was posted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const out = await proposeSessionMessageTool.call(valid, deps);

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("ECONNREFUSED");
  });

  /**
   * A copy assertion, and only that: req 5 is enforced by the route, not here.
   * It exists because the wording is what stops an agent from waiting for a
   * reply that never comes, or assuming it now has a channel.
   */
  it("says in its result text that the delivery is one-way and one-shot", async () => {
    stubFetch(200, { ok: true, targetTitle: "Orchestrator" });
    const out = await proposeSessionMessageTool.call(valid, deps);
    expect(out.content[0].text).toContain("delivered once");
  });
});
