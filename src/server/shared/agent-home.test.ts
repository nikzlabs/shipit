import { describe, it, expect, afterEach } from "vitest";
import { agentHome, codexHome, resolveAgentHome, DEFAULT_AGENT_HOME } from "./agent-home.js";

describe("agent-home (docs/150)", () => {
  const prevAgentHome = process.env.AGENT_HOME;
  const prevCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (prevAgentHome === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = prevAgentHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  it("defaults to /home/shipit when AGENT_HOME is unset", () => {
    delete process.env.AGENT_HOME;
    expect(agentHome()).toBe("/home/shipit");
    expect(DEFAULT_AGENT_HOME).toBe("/home/shipit");
  });

  it("honors AGENT_HOME at call time (local mode keeps /root)", () => {
    process.env.AGENT_HOME = "/root";
    expect(agentHome()).toBe("/root");
    process.env.AGENT_HOME = "/home/shipit";
    expect(agentHome()).toBe("/home/shipit");
  });

  it("codexHome() defaults to agentHome() + /.codex", () => {
    delete process.env.CODEX_HOME;
    delete process.env.AGENT_HOME;
    expect(codexHome()).toBe("/home/shipit/.codex");
    process.env.AGENT_HOME = "/root";
    expect(codexHome()).toBe("/root/.codex");
  });

  it("codexHome() honors an explicit CODEX_HOME override", () => {
    process.env.CODEX_HOME = "/custom/codex";
    expect(codexHome()).toBe("/custom/codex");
  });

  describe("resolveAgentHome", () => {
    it("falls back to agentHome() when no account root applies", () => {
      process.env.AGENT_HOME = "/root";
      expect(resolveAgentHome()).toBe("/root");
      expect(resolveAgentHome(undefined)).toBe("/root");
      expect(resolveAgentHome("")).toBe("/root");
    });

    it("uses the account root when one is given", () => {
      process.env.AGENT_HOME = "/root";
      expect(resolveAgentHome("/credentials/provider-accounts/claude/acct-a"))
        .toBe("/credentials/provider-accounts/claude/acct-a");
    });
  });
});
