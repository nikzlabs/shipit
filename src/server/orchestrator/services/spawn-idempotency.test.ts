import { describe, it, expect } from "vitest";
import { SpawnClaims } from "./spawn-idempotency.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("SpawnClaims", () => {
  it("runs the spawn once for a repeated key and reports the repeat as deduplicated", async () => {
    const claims = new SpawnClaims<string>();
    let spawns = 0;
    const spawn = async () => { spawns += 1; return `session-${spawns}`; };

    const first = await claims.run("k", spawn);
    const second = await claims.run("k", spawn);

    expect(spawns).toBe(1);
    expect(first).toEqual({ result: "session-1", deduplicated: false });
    expect(second).toEqual({ result: "session-1", deduplicated: true });
  });

  it("collapses concurrent callers onto one spawn", async () => {
    const claims = new SpawnClaims<string>();
    const gate = deferred<string>();
    let spawns = 0;
    const spawn = () => { spawns += 1; return gate.promise; };

    const both = Promise.all([claims.run("k", spawn), claims.run("k", spawn)]);
    gate.resolve("session-1");
    const [a, b] = await both;

    // A check-then-await gap would let the second caller spawn before the first registered.
    expect(spawns).toBe(1);
    expect(a.result).toBe("session-1");
    expect(b.result).toBe("session-1");
    expect([a.deduplicated, b.deduplicated]).toContain(true);
  });

  it("does not replay a failure: the next attempt under that key really spawns", async () => {
    const claims = new SpawnClaims<string>();
    let spawns = 0;
    const spawn = async () => {
      spawns += 1;
      if (spawns === 1) throw new Error("per-turn spawn limit reached");
      return "session-2";
    };

    await expect(claims.run("k", spawn)).rejects.toThrow("per-turn spawn limit");
    const retry = await claims.run("k", spawn);

    expect(spawns).toBe(2);
    expect(retry).toEqual({ result: "session-2", deduplicated: false });
  });

  it("spawns separately once the claim has expired", async () => {
    let now = 1_000;
    const claims = new SpawnClaims<string>({ ttlMs: 60_000, now: () => now });
    let spawns = 0;
    const spawn = async () => { spawns += 1; return `session-${spawns}`; };

    await claims.run("k", spawn);
    now += 60_001;
    const after = await claims.run("k", spawn);

    expect(spawns).toBe(2);
    expect(after).toEqual({ result: "session-2", deduplicated: false });
  });

  it("keeps different keys apart", async () => {
    const claims = new SpawnClaims<string>();
    let spawns = 0;
    const spawn = async () => { spawns += 1; return `session-${spawns}`; };

    await claims.run("a", spawn);
    await claims.run("b", spawn);

    expect(spawns).toBe(2);
  });
});
