import { describe, it, expect, vi } from "vitest";
import type { SessionManager } from "../sessions.js";
import type { SessionStartParams } from "../../shared/types.js";
import {
  applyStartParams,
  firstDispatchParams,
  hasStartParams,
  startSelection,
  type StartParamDeps,
} from "./session-start-params.js";

const ALL: SessionStartParams = {
  role: "reviewer",
  agent: "codex",
  model: "gpt-5.4",
  serviceId: "openai",
  billingMode: "sub",
  reasoning: "high",
  permissionMode: "plan",
  networkMode: false,
  sshHosts: ["prod"],
  armAutoMerge: true,
};

describe("session-start parameter phases", () => {
  it("resolves only the harness and model choices together", () => {
    expect(startSelection(ALL)).toEqual({
      role: "reviewer",
      agent: "codex",
      model: "gpt-5.4",
      serviceId: "openai",
      billingMode: "sub",
      reasoning: "high",
    });
  });

  it("puts only the permission mode on the first dispatch", () => {
    expect(firstDispatchParams(ALL)).toEqual({ permissionMode: "plan" });
    expect(firstDispatchParams({})).toEqual({});
  });

  it("treats an empty SSH list as no grant, so the start need not wait for the container", () => {
    expect(hasStartParams({ sshHosts: [] }, "ready")).toBe(false);
    expect(hasStartParams({ sshHosts: ["prod"] }, "ready")).toBe(true);
  });

  it("applies nothing in a phase whose parameters are absent or empty", async () => {
    const setSshHosts = vi.fn();
    const deps: StartParamDeps = {
      sessionManager: { setSshHosts } as unknown as SessionManager,
      credentialStore: undefined,
    };

    const ctx = { sessionId: "s", agentId: "claude" as const, deps };
    await applyStartParams("session", { sshHosts: [], networkMode: null }, ctx);
    await applyStartParams("ready", { sshHosts: [], networkMode: null }, ctx);

    expect(setSshHosts).not.toHaveBeenCalled();
  });
});
