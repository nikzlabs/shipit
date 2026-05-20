import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionWorker } from "./session-worker.js";
import type { AgentProcess } from "./agents/agent-process.js";

/**
 * docs/125 — Codex registers the review bridge via `[mcp_servers.*]` in
 * config.toml (not a per-run path like Claude). These tests cover the worker's
 * config writer in isolation: it must append a managed block, be idempotent,
 * and never clobber a user's existing config.
 */
describe("SessionWorker.ensureCodexReviewMcpConfig (docs/125)", () => {
  let codexHome: string;
  let worker: SessionWorker;
  const prevHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env.CODEX_HOME = codexHome;
    worker = new SessionWorker({
      agentFactory: () => ({ agentId: "codex" }) as unknown as AgentProcess,
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  function ensure(): void {
    (worker as unknown as { ensureCodexReviewMcpConfig: () => void }).ensureCodexReviewMcpConfig();
  }

  const configText = (): string => fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");

  it("appends a managed [mcp_servers.shipit-review] block pointing at the bridge", () => {
    ensure();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.shipit-review]");
    expect(cfg).toContain("mcp-review-bridge.ts");
    expect(cfg).toMatch(/command = ".+tsx"/);
  });

  it("is idempotent — repeat calls do not duplicate the block", () => {
    ensure();
    ensure();
    const occurrences = configText().split("[mcp_servers.shipit-review]").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves a user's pre-existing config (append, not clobber)", () => {
    const existing = '[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), existing);
    ensure();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.linear]");
    expect(cfg).toContain("[mcp_servers.shipit-review]");
  });
});
