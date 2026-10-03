import { describe, expect, it } from "vitest";
import type { SessionListRow } from "../../server/shared/types.js";
import { reuseUnchangedRows } from "./session-rows.js";

const row = (id: string, over: Partial<SessionListRow> = {}): SessionListRow => ({
  id,
  title: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "https://github.com/o/r",
  capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: false },
  sshHosts: ["h1"],
  ...over,
});

// Each broadcast is parsed into new objects, so the copies here are what a real one looks like.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("reuseUnchangedRows", () => {
  it("keeps the previous array when no row changed", () => {
    const prev = [row("a"), row("b")];
    expect(reuseUnchangedRows(prev, copy(prev))).toBe(prev);
  });

  it("keeps each unchanged row and takes the changed one", () => {
    const prev = [row("a"), row("b")];
    const next = copy(prev);
    next[1] = row("b", { lastUsedAt: "2026-01-02T00:00:00.000Z" });

    const result = reuseUnchangedRows(prev, next);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(next[1]);
  });

  it("sees a change inside a nested value", () => {
    const prev = [row("a")];
    const next = [row("a", { capabilities: { git: true, docker: true, network: true, dangerousGitHubOps: false } })];
    expect(reuseUnchangedRows(prev, next)[0]).toBe(next[0]);
  });

  it("follows a new order, an added row and a removed row", () => {
    const prev = [row("a"), row("b")];

    const reordered = reuseUnchangedRows(prev, copy([prev[1], prev[0]]));
    expect(reordered).toEqual([prev[1], prev[0]]);
    expect(reordered[0]).toBe(prev[1]);

    const added = reuseUnchangedRows(prev, [...copy(prev), row("c")]);
    expect(added).toHaveLength(3);
    expect(added[0]).toBe(prev[0]);

    expect(reuseUnchangedRows(prev, copy([prev[0]]))).toEqual([prev[0]]);
  });

  it("treats a field that is gone as a change", () => {
    const prev = [row("a", { mutedAt: "2026-01-02T00:00:00.000Z" })];
    const next = [row("a")];
    expect(reuseUnchangedRows(prev, next)[0]).toBe(next[0]);
  });
});
