import { describe, it, expect, vi } from "vitest";
import { CodexEventHandler, formatCodexConfigWarning } from "./codex-event-handler.js";
import { CodexRateLimits } from "./codex-rate-limits.js";
import type { CodexTransport } from "./codex-event-handler.js";
import type { AgentEvent } from "../agent-process.js";

// Notification fixtures come from codex-cli 0.153.2.
function makeHandler(): {
  handler: CodexEventHandler;
  logs: { source: string; text: string }[];
  events: AgentEvent[];
} {
  const logs: { source: string; text: string }[] = [];
  const events: AgentEvent[] = [];
  const ctx: CodexTransport = {
    emitEvent: (event) => events.push(event),
    emitLog: (source, text) => logs.push({ source, text }),
    sendRequest: vi.fn(async () => ({})),
    sendResponse: vi.fn(),
    sendErrorResponse: vi.fn(),
    sendNotification: vi.fn(),
    kill: vi.fn(),
  };
  return { handler: new CodexEventHandler(ctx, new CodexRateLimits(), []), logs, events };
}

/** Assistant text blocks, which is where a sandbox notice lands. */
function assistantText(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "agent_assistant" }> => e.type === "agent_assistant")
    .flatMap((e) => e.content)
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** A completed shell item whose output is `output`. */
function shellResult(id: string, output: string): { method: string; params: Record<string, unknown> } {
  return {
    method: "item/completed",
    params: { item: { id, type: "commandExecution", command: "ls", exitCode: 1, aggregatedOutput: output } },
  };
}

describe("configWarning", () => {
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

/**
 * The incident: every tool call in a session failed with `bwrap: No permissions
 * to create new namespace…`, the turn settled as errored, and nothing said why.
 * Bubblewrap can never start in a ShipIt container (`CapDrop: ALL`), so the
 * user's only remaining question is WHICH policy layer switched the sandbox
 * back on — and that answer belongs next to the failures, not in a log.
 *
 * The strings are real: the bubblewrap line reproduced in a session container,
 * the veto phrasings read out of codex-cli 0.153.2's string table.
 */
describe("sandbox diagnostics", () => {
  const BWRAP =
    "bwrap: No permissions to create new namespace, likely because the kernel does not "
    + "allow non-privileged user namespaces.";

  it("explains a bubblewrap failure in the transcript, not only the log", () => {
    const { handler, logs, events } = makeHandler();
    handler.handleNotification(shellResult("c1", BWRAP));

    const text = assistantText(events);
    expect(text).toContain("Codex's sandbox cannot run in this container");
    expect(text).toContain("CAP_SYS_ADMIN");
    // Names the knobs, so the reader can tell an overridden setting from an
    // unset one without going to read ShipIt's source.
    expect(text).toContain("use_legacy_landlock");
    expect(text).toContain("requirements.toml");
    expect(logs.some((l) => l.source === "server" && l.text.includes("CAP_SYS_ADMIN"))).toBe(true);
  });

  it("still emits the tool result it diagnosed, and puts the notice after it", () => {
    const { handler, events } = makeHandler();
    handler.handleNotification(shellResult("c1", BWRAP));

    const kinds = events.map((e) => e.type);
    const result = kinds.indexOf("agent_tool_result");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(kinds.lastIndexOf("agent_assistant")).toBeGreaterThan(result);
  });

  it("says it once, however many commands fail", () => {
    const { handler, events } = makeHandler();
    handler.handleNotification(shellResult("c1", BWRAP));
    handler.handleNotification(shellResult("c2", BWRAP));
    handler.handleNotification(shellResult("c3", BWRAP));

    const occurrences = assistantText(events).split("Codex's sandbox cannot run").length - 1;
    expect(occurrences).toBe(1);
  });

  it("leaves ordinary tool failures alone", () => {
    const { handler, logs, events } = makeHandler();
    handler.handleNotification(shellResult("c1", "ls: cannot access 'nope': No such file or directory"));

    expect(assistantText(events)).toBe("");
    expect(logs).toHaveLength(0);
  });

  it("promotes a requirements veto out of the log and into the transcript", () => {
    const { handler, events } = makeHandler();
    handler.handleNotification({
      method: "configWarning",
      params: {
        summary: "`sandbox_mode` is disallowed by requirements; falling back to required value "
          + "`workspace-write`.",
      },
    });

    const text = assistantText(events);
    expect(text).toContain("Codex refused a ShipIt setting");
    // The warning's own wording carries through — it names the vetoed key,
    // which is the part that says which policy line to go and change.
    expect(text).toContain("`sandbox_mode` is disallowed by requirements");
    expect(text).toContain("requirements.toml");
  });

  it("recognizes the veto phrased with the verb after `requirements`", () => {
    const { handler, events } = makeHandler();
    handler.handleNotification({
      method: "configWarning",
      params: {
        summary: "`approval_policy = \"never\"` cannot be used because requirements do not allow "
          + "`sandbox_mode = \"danger-full-access\"`.",
      },
    });

    expect(assistantText(events)).toContain("Codex refused a ShipIt setting");
  });

  it("keeps a non-veto warning as a log line only", () => {
    const { handler, logs, events } = makeHandler();
    handler.handleNotification({
      method: "configWarning",
      params: { summary: "Invalid configuration; using defaults.", details: "config.toml:4:11: duplicate key" },
    });

    expect(assistantText(events)).toBe("");
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toContain("Invalid configuration");
  });
});
