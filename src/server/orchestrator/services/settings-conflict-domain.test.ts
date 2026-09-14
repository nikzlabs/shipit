import { describe, it, expect } from "vitest";
import {
  conflictDomainsIdle,
  mcpServerDomain,
  roleDomain,
  settingsPayloadDomain,
  withConflictDomains,
} from "./settings-conflict-domain.js";

/**
 * The lock the shared apply layer takes (docs/299-agent-settings-access,
 * plan.md → The target, and the lock).
 *
 * What it buys is ORDERING. There is deliberately no test here promising
 * conflict detection: the MCP editor captures a whole server object when it
 * opens and submits a complete configuration, so a form opened before another
 * write still overwrites it — in correct order. That is pre-existing
 * last-write-wins, which this neither introduces nor closes, and a test claiming
 * otherwise would be describing a guarantee nothing provides.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("withConflictDomains", () => {
  it("runs writers of one stored object one at a time, in the order they arrived", async () => {
    const order: string[] = [];
    const gate = deferred();

    // A card apply, a dialog save of the whole role, and an edit to one of its
    // fields: three writers of ONE stored role, so all three take its domain.
    const first = withConflictDomains([roleDomain("writer")], async () => {
      order.push("card:start");
      await gate.promise;
      order.push("card:end");
    });
    const second = withConflictDomains([roleDomain("writer")], () => {
      order.push("dialog");
    });
    const third = withConflictDomains([roleDomain("writer")], () => {
      order.push("field-edit");
    });

    // Nothing after the first may have started while it is still running.
    await Promise.resolve();
    expect(order).toEqual(["card:start"]);

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["card:start", "card:end", "dialog", "field-edit"]);
  });

  it("lets writers of different stored objects run at the same time", async () => {
    const order: string[] = [];
    const gate = deferred();

    const held = withConflictDomains([roleDomain("writer")], async () => {
      order.push("role:start");
      await gate.promise;
      order.push("role:end");
    });
    // A different role is a different stored object, so it is not behind that.
    const other = withConflictDomains([roleDomain("reviewer")], () => {
      order.push("other-role");
    });
    await other;
    expect(order).toEqual(["role:start", "other-role"]);

    gate.resolve();
    await held;
  });

  it("orders an operation that takes several domains against each of them", async () => {
    const order: string[] = [];
    const gate = deferred();

    // A settings save that also writes a role holds both, so a later writer of
    // EITHER waits for it.
    const save = withConflictDomains([settingsPayloadDomain, roleDomain("writer")], async () => {
      order.push("save:start");
      await gate.promise;
      order.push("save:end");
    });
    const roleEdit = withConflictDomains([roleDomain("writer")], () => { order.push("role-edit"); });
    const scalarEdit = withConflictDomains([settingsPayloadDomain], () => { order.push("scalar-edit"); });

    await Promise.resolve();
    expect(order).toEqual(["save:start"]);

    gate.resolve();
    await Promise.all([save, roleEdit, scalarEdit]);
    expect(order).toEqual(["save:start", "save:end", "role-edit", "scalar-edit"]);
  });

  it("does not deadlock when two operations name overlapping domains in opposite orders", async () => {
    const order: string[] = [];
    const a = withConflictDomains([roleDomain("b"), roleDomain("a")], async () => {
      order.push("a:start");
      await Promise.resolve();
      order.push("a:end");
    });
    const b = withConflictDomains([roleDomain("a"), roleDomain("b")], () => { order.push("b"); });

    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("releases a domain whose writer threw, so the next writer still runs", async () => {
    const order: string[] = [];
    const failing = withConflictDomains([mcpServerDomain("notion")], () => {
      order.push("failing");
      throw new Error("validation refused this write");
    });
    const next = withConflictDomains([mcpServerDomain("notion")], () => { order.push("next"); });

    await expect(failing).rejects.toThrow("validation refused this write");
    await next;
    expect(order).toEqual(["failing", "next"]);
  });

  it("forgets a domain nobody is waiting on, so the map does not grow per role forever", async () => {
    for (const name of ["a", "b", "c"]) {
      await withConflictDomains([roleDomain(name)], () => undefined);
    }
    expect(conflictDomainsIdle()).toBe(true);
  });
});
