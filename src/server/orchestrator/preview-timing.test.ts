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
    markStackUp(SID, [{ name: "web", port: 5173 }]);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`preview.first-connect for ${SID} port=5173`);
    expect(logged[0]).toMatch(/afterComposeUp=\d+ms/);
    expect(logged[0]).toContain("service=web");
  });

  it("reports once per port, not once per request", () => {
    markStackUp(SID, [{ name: "web", port: 5173 }]);
    markPreviewReachable(SID, 5173);
    markPreviewReachable(SID, 5173);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(1);
  });

  it("reports each port of a multi-service stack", () => {
    markStackUp(SID, [{ name: "web", port: 5173 }, { name: "api", port: 3000 }]);
    markPreviewReachable(SID, 5173);
    markPreviewReachable(SID, 3000);

    expect(logged).toHaveLength(2);
    expect(logged[1]).toContain("port=3000");
    expect(logged[1]).toContain("service=api");
  });

  it("measures again after the next compose up — a restart is a new boot", () => {
    markStackUp(SID, [{ name: "web", port: 5173 }]);
    markPreviewReachable(SID, 5173);
    markStackUp(SID, [{ name: "web", port: 5173 }]);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(2);
  });

  it("leaves an untouched port alone when a later batch starts other services", () => {
    markStackUp(SID, [{ name: "web", port: 5173 }]);
    markPreviewReachable(SID, 5173);
    logged.length = 0;

    markStackUp(SID, [{ name: "api", port: 3000 }]);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(0);

    markPreviewReachable(SID, 3000);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("service=api");
  });

  it("ignores a service with no published port", () => {
    markStackUp(SID, [{ name: "db" }]);
    markPreviewReachable(SID, 5432);

    expect(logged).toHaveLength(0);
  });

  it("says nothing for a preview whose stack this process never started", () => {
    markPreviewReachable("sess-never-started", 5173);

    expect(logged).toHaveLength(0);
  });

  it("says nothing once the stack is forgotten", () => {
    markStackUp(SID, [{ name: "web", port: 5173 }]);
    forgetStackUp(SID);
    markPreviewReachable(SID, 5173);

    expect(logged).toHaveLength(0);
  });
});
