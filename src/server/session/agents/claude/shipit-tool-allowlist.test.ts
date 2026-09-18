import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";

vi.mock("node:child_process", async () => {
  // eslint-disable-next-line no-restricted-syntax
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...real, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { ClaudeProcess, StreamingClaudeProcess } from "./process.js";
import { ClaudeAdapter } from "./adapter.js";
import { selectTools } from "../../mcp-shipit-bridge.js";
import type { PermissionMode } from "../../../shared/types.js";

const mockSpawn = vi.mocked(childProcess.spawn);

/**
 * The CLI invokes this gate itself; allowlisting it would let the model answer
 * its own permission prompt.
 */
const CLI_ONLY_TOOLS = new Set(["permission_prompt"]);

function createMockChildProcess() {
  const stdin: any = new EventEmitter();
  stdin.write = vi.fn(() => true);
  stdin.end = vi.fn();
  stdin.writable = true;
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = stdin;
  proc.kill = vi.fn();
  proc.pid = 4321;
  return proc;
}

/** The tools the shipit MCP bridge actually serves this harness. */
function bridgeToolNames(sessionStatusCard: boolean): string[] {
  const adapter = new ClaudeAdapter(new EventEmitter() as never);
  const result = adapter.writeMcpConfig({
    servers: [],
    shipitBridge: { tsxBin: "/opt/node", bridgePath: "/opt/mcp-shipit-bridge.js" },
    sessionStatusCard,
    onServerFailed: vi.fn(),
  });
  const config = JSON.parse(fs.readFileSync(result.mcpConfigPath!, "utf-8")) as {
    mcpServers: { shipit: { env: { SHIPIT_MCP_TOOLS: string } } };
  };
  result.cleanup?.();
  return selectTools(config.mcpServers.shipit.env.SHIPIT_MCP_TOOLS).map((t) => t.name);
}

function allowlistFor(
  kind: "one-shot" | "streaming",
  permissionMode: PermissionMode | undefined,
  sessionStatusCard: boolean,
): string[] {
  mockSpawn.mockReturnValue(createMockChildProcess() as never);
  const proc = kind === "streaming" ? new StreamingClaudeProcess() : new ClaudeProcess();
  proc.run({ prompt: "test", permissionMode, sessionStatusCard });
  const args = mockSpawn.mock.calls[0][1] as string[];
  return args[args.indexOf("--allowedTools") + 1].split(",");
}

/**
 * A bridge tool absent from `--allowedTools` is not denied — it is routed to
 * `--permission-prompt-tool`, so the user hand-approves an internal ShipIt tool
 * before the card it exists to post appears. `propose_repo_session` shipped that
 * way. Derived from the bridge's own list so the next tool cannot repeat it.
 */
describe("Claude allowlists every shipit bridge tool it serves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a bridge list the allowlist can be checked against", () => {
    expect(bridgeToolNames(false)).toEqual(
      expect.arrayContaining(["present", "voice_note", "report_shipit_bug", "permission_prompt", "propose_actions", "propose_repo_session"]),
    );
    expect(bridgeToolNames(true)).toContain("session_status");
  });

  const cases = [
    ["one-shot", "auto", undefined],
    ["one-shot", "plan", "plan"],
    ["one-shot", "guarded", "guarded"],
    ["streaming", "auto", undefined],
    ["streaming", "plan", "plan"],
    ["streaming", "guarded", "guarded"],
  ] as const;

  it.each(cases)("%s process, %s mode", (kind, _label, permissionMode) => {
    for (const sessionStatusCard of [false, true]) {
      const allowed = allowlistFor(kind, permissionMode as PermissionMode | undefined, sessionStatusCard);
      for (const name of bridgeToolNames(sessionStatusCard)) {
        const qualified = `mcp__shipit__${name}`;
        if (CLI_ONLY_TOOLS.has(name)) {
          expect(allowed).not.toContain(qualified);
        } else {
          expect(allowed).toContain(qualified);
        }
      }
      vi.clearAllMocks();
    }
  });
});
