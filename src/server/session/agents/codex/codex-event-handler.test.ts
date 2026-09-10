import { describe, it, expect, vi } from "vitest";
import { CodexEventHandler, formatCodexConfigWarning } from "./codex-event-handler.js";
import { CodexRateLimits } from "./codex-rate-limits.js";
import type { CodexTransport } from "./codex-event-handler.js";

// Notification fixtures come from codex-cli 0.153.2.
describe("configWarning", () => {
  function makeHandler(): { handler: CodexEventHandler; logs: { source: string; text: string }[] } {
    const logs: { source: string; text: string }[] = [];
    const ctx: CodexTransport = {
      emitEvent: vi.fn(),
      emitLog: (source, text) => logs.push({ source, text }),
      sendRequest: vi.fn(async () => ({})),
      sendResponse: vi.fn(),
      sendErrorResponse: vi.fn(),
      sendNotification: vi.fn(),
      kill: vi.fn(),
    };
    return { handler: new CodexEventHandler(ctx, new CodexRateLimits(), []), logs };
  }

  it("logs an invalid config as a server-level problem, naming the file and position", () => {
    const { handler, logs } = makeHandler();
    handler.handleNotification({
      method: "configWarning",
      params: {
        summary: "Invalid configuration; using defaults.",
        details: "/credentials/.codex/config.toml:4:11: duplicate key",
        path: "/credentials/.codex/config.toml",
        range: { start: { line: 4, column: 11 }, end: { line: 4, column: 22 } },
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe("server");
    expect(logs[0].text).toContain("Invalid configuration; using defaults.");
    expect(logs[0].text).toContain("/credentials/.codex/config.toml:4:11: duplicate key");
  });

  it("flattens the multi-line untrusted-project warning into one line", () => {
    const { handler, logs } = makeHandler();
    handler.handleNotification({
      method: "configWarning",
      params: {
        summary:
          "Project-local config, hooks, and exec policies are disabled in the following folders "
          + "until the project is trusted, but skills still load.\n    1. /workspace/.codex\n"
          + "       To load project-local config, hooks, and exec policies, add /workspace as a "
          + "trusted project in /credentials/.codex/config.toml.",
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe("server");
    expect(logs[0].text.startsWith("Codex configuration: ")).toBe(true);
    expect(logs[0].text).not.toContain("\n");
    expect(logs[0].text).not.toContain("\\n");
    expect(logs[0].text).toContain("1. /workspace/.codex");
  });

  it("says nothing when the notification carries no text", () => {
    const { handler, logs } = makeHandler();
    handler.handleNotification({ method: "configWarning", params: {} });
    expect(logs).toHaveLength(0);
  });

  describe("formatCodexConfigWarning", () => {
    it("joins summary and details, and returns null for neither", () => {
      expect(formatCodexConfigWarning({ summary: "Broken.", details: "line 4" }))
        .toBe("Codex configuration: Broken. — line 4");
      expect(formatCodexConfigWarning({ summary: "Broken." }))
        .toBe("Codex configuration: Broken.");
      expect(formatCodexConfigWarning({ details: "line 4" }))
        .toBe("Codex configuration: line 4");
      expect(formatCodexConfigWarning({})).toBeNull();
      expect(formatCodexConfigWarning({ summary: "   " })).toBeNull();
      expect(formatCodexConfigWarning({ summary: 42 })).toBeNull();
    });

    it("truncates a very long warning rather than flooding the log", () => {
      const text = formatCodexConfigWarning({ summary: "x".repeat(2000) });
      expect(text).not.toBeNull();
      expect(text!.length).toBeLessThan(500);
      expect(text!.endsWith("…")).toBe(true);
    });

    it("keeps the details when the summary is the long part", () => {
      const text = formatCodexConfigWarning({
        summary: "y".repeat(2000),
        details: "/credentials/.codex/config.toml:4:11: duplicate key",
      });
      expect(text).toContain("/credentials/.codex/config.toml:4:11: duplicate key");
    });
  });
});
