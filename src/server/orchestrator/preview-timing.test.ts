/**
 * Tests for the activation→preview-ready clock.
 *
 * The one measurement that spans two modules: `ServiceManager` starts it when
 * `docker compose up` returns, `preview-proxy` stops it on the first request the
 * upstream answered. What matters is that it reports once per boot (a preview
 * serves hundreds of requests) and stays silent when it has no start time to
 * measure from.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { markStackUp, markPreviewReachable, forgetStackUp } from "./preview-timing.js";

const SID = "sess-timing-1";

let logged: string[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
    if (typeof msg === "string" && msg.startsWith("[timing]")) logged.push(msg);
  });
});

afterEach(() => {
  spy.mockRestore();
  forgetStackUp(SID);
});

describe("preview timing", () => {
  it("reports the gap between the compose up and the first answered request", () => {
    markStackUp(SID, ["web"]);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`preview.first-connect for ${SID} port=5173`);
    expect(logged[0]).toMatch(/afterComposeUp=\d+ms/);
    expect(logged[0]).toContain("services=web");
  });

  it("reports once per port, not once per request", () => {
    markStackUp(SID, ["web"]);
    markPreviewReachable(SID, 5173);
    markPreviewReachable(SID, 5173);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(1);
  });

  it("reports each port of a multi-service stack", () => {
    markStackUp(SID, ["web", "api"]);
    markPreviewReachable(SID, 5173);
    markPreviewReachable(SID, 3000);

    expect(logged).toHaveLength(2);
    expect(logged[1]).toContain("port=3000");
  });

  it("measures again after the next compose up — a restart is a new boot", () => {
    markStackUp(SID, ["web"]);
    markPreviewReachable(SID, 5173);
    markStackUp(SID, ["web"]);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(2);
  });

  it("says nothing for a preview whose stack this process never started", () => {
    markPreviewReachable("sess-never-started", 5173);

    expect(logged).toHaveLength(0);
  });

  it("says nothing once the stack is forgotten", () => {
    markStackUp(SID, ["web"]);
    forgetStackUp(SID);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(0);
  });
});
