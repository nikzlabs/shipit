import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSubAgentSpawn } from "./sub-agent-spawn.js";
import type { HandlerContext } from "./types.js";
import type { WsSubAgentSpawn } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ subAgentSpawns: {} });
});

describe("handleSubAgentSpawn (docs/144)", () => {
  it("adds a running chip keyed by spawnId", () => {
    const msg: WsSubAgentSpawn = { type: "sub_agent_spawn", spawnId: "x1", subAgentId: "codex", phase: "running" };
    handleSubAgentSpawn(ctx, msg);
    const chip = useSessionStore.getState().subAgentSpawns.x1;
    expect(chip).toMatchObject({ subAgentId: "codex", phase: "running" });
  });

  it("replaces the running chip with the done chip on the same spawnId", () => {
    handleSubAgentSpawn(ctx, { type: "sub_agent_spawn", spawnId: "x1", subAgentId: "codex", phase: "running" });
    handleSubAgentSpawn(ctx, {
      type: "sub_agent_spawn",
      spawnId: "x1",
      subAgentId: "codex",
      phase: "done",
      status: "success",
      durationMs: 4700,
      costUsd: 0.03,
    });
    const spawns = useSessionStore.getState().subAgentSpawns;
    expect(Object.keys(spawns)).toEqual(["x1"]);
    expect(spawns.x1).toMatchObject({ phase: "done", status: "success", durationMs: 4700, costUsd: 0.03 });
  });
});
