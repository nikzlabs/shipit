import { describe, it, expect, vi } from "vitest";
import { CodexEventHandler, formatCodexConfigWarning } from "./codex-event-handler.js";
import { CodexRateLimits } from "./codex-rate-limits.js";
import type { CodexTransport } from "./codex-event-handler.js";

/**
 * `configWarning` is the app-server's verdict on `$CODEX_HOME/config.toml`,
 * sent right after `initialize`. ShipIt used to drop it into the catch-all
 * "unhandled notification" log, where it was one truncated `codex-rpc` line
 * among many — and the consequence it reports is invisible: an invalid config
 * makes Codex fall back to its defaults, which drops ShipIt's whole
 * `[mcp_servers.*]` block (Playwright, the shipit bridge) with no error on the
 * turn.
 *
 * Both notification shapes below were captured off the real app-server
 * (codex-cli 0.153.2), not invented.
 */
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

    // `server`, not `codex-rpc`: the catch-all branch uses the latter, so this
    // cannot pass on an unhandled notification.
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
    // Source and prefix, not just the folder: the old catch-all branch logged
    // `JSON.stringify(params)` under `codex-rpc`, whose escaped "\n" would sail
    // past a newline assertion and still contain the folder name.
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
      // The budgets are per field on purpose: `details` names the file, line
      // and column, so a rambling summary must not be able to truncate the one
      // part that says what to fix.
      const text = formatCodexConfigWarning({
        summary: "y".repeat(2000),
        details: "/credentials/.codex/config.toml:4:11: duplicate key",
      });
      expect(text).toContain("/credentials/.codex/config.toml:4:11: duplicate key");
    });
  });
});
