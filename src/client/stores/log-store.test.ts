import { describe, it, expect, beforeEach } from "vitest";
import { useLogStore } from "./log-store.js";

beforeEach(() => useLogStore.getState().reset());

describe("log-store", () => {
  it("snapshot replaces records and bumps epoch", () => {
    const { snapshot } = useLogStore.getState();
    snapshot("agent", [{ ts: "t", source: "server", text: "a" }]);
    const e1 = useLogStore.getState().channels.agent.epoch;
    snapshot("agent", [{ ts: "t", source: "server", text: "b" }]);
    const ch = useLogStore.getState().channels.agent;
    expect(ch.records.map((r) => r.text)).toEqual(["b"]);
    expect(ch.epoch).toBeGreaterThan(e1);
  });

  it("append extends without bumping epoch (pure tail)", () => {
    const { snapshot, append } = useLogStore.getState();
    snapshot("agent", [{ ts: "t", source: "server", text: "a" }]);
    const epoch = useLogStore.getState().channels.agent.epoch;
    append("agent", [{ ts: "t", source: "stdout", text: "b" }]);
    const ch = useLogStore.getState().channels.agent;
    expect(ch.records.map((r) => r.text)).toEqual(["a", "b"]);
    expect(ch.epoch).toBe(epoch);
  });

  it("isolates channels", () => {
    const { snapshot } = useLogStore.getState();
    snapshot("agent", [{ ts: "t", text: "agent-line" }]);
    snapshot("service:web", [{ ts: "", text: "web-line" }]);
    expect(useLogStore.getState().channels.agent.records).toHaveLength(1);
    expect(useLogStore.getState().channels["service:web"].records).toHaveLength(1);
  });

  it("clearChannel empties records and bumps epoch", () => {
    const { snapshot, clearChannel } = useLogStore.getState();
    snapshot("agent", [{ ts: "t", text: "x" }]);
    const epoch = useLogStore.getState().channels.agent.epoch;
    clearChannel("agent");
    const ch = useLogStore.getState().channels.agent;
    expect(ch.records).toEqual([]);
    expect(ch.epoch).toBeGreaterThan(epoch);
  });

  it("trims to a bounded buffer and bumps epoch on overflow", () => {
    const { append } = useLogStore.getState();
    // Push well past the 5000 cap in one batch.
    const batch = Array.from({ length: 6000 }, (_, i) => ({ ts: "t", text: `line${i}` }));
    append("agent", batch);
    const ch = useLogStore.getState().channels.agent;
    expect(ch.records.length).toBeLessThanOrEqual(5000);
    // Trim drops the head — newest survive.
    expect(ch.records[ch.records.length - 1].text).toBe("line5999");
    expect(ch.epoch).toBeGreaterThan(0);
  });

  it("reset drops all channels", () => {
    const { snapshot, reset } = useLogStore.getState();
    snapshot("agent", [{ ts: "t", text: "x" }]);
    reset();
    expect(useLogStore.getState().channels).toEqual({});
  });
});
