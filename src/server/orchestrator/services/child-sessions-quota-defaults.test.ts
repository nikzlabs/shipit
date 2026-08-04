/**
 * Unit tests for the spawn-quota default constants (docs/117, docs/162).
 *
 * The constants are read from the environment once at module init, so every
 * env-override case re-imports the module under `vi.resetModules()` with the
 * var stubbed. The bare-default cases assert the compile-time numbers and the
 * one relationship that is a deliberate design decision rather than an
 * accident: the Ops fix-session per-turn cap sits *above* the generic fan-out
 * per-turn cap, because an Ops investigation legitimately produces several
 * independent defects in a single turn.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS,
  DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN,
  DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN,
} from "./child-sessions.js";

/** Re-import the module with a fresh env so the module-init reads re-run. */
async function importWithEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  return await import("./child-sessions.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("spawn quota defaults", () => {
  it("uses the compile-time defaults when no env override is set", () => {
    expect(DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS).toBe(16);
    expect(DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN).toBe(4);
    expect(DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN).toBe(5);
  });

  it("allows more ShipIt-fix spawns per turn than generic fan-out spawns", () => {
    expect(DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN).toBeGreaterThan(DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN);
  });

  it("keeps the per-parent cap as the wider bound", () => {
    expect(DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS).toBeGreaterThan(DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN);
  });
});

describe("spawn quota env overrides", () => {
  it("honours a positive-integer override for each quota", async () => {
    const mod = await importWithEnv({
      MAX_SPAWNED_SESSIONS_PER_PARENT: "32",
      MAX_SPAWNED_SESSIONS_PER_TURN: "7",
      MAX_SHIPIT_FIX_SESSIONS_PER_TURN: "1",
    });
    expect(mod.DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS).toBe(32);
    expect(mod.DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN).toBe(7);
    // Below the generic cap: the override can still take the Ops cap lower.
    expect(mod.DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN).toBe(1);
  });

  it("falls back to the compile-time default on an unparseable override", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importWithEnv({ MAX_SHIPIT_FIX_SESSIONS_PER_TURN: "not-a-number" });
    expect(mod.DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to the compile-time default on a non-positive override", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importWithEnv({ MAX_SHIPIT_FIX_SESSIONS_PER_TURN: "0" });
    expect(mod.DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN).toBe(5);
    warn.mockRestore();
  });
});
