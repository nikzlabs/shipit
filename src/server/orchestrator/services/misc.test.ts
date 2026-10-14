import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { UsageManager } from "../usage.js";
import { fullReset } from "./misc.js";

describe("fullReset — /persist volumes (docs/331)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("stops every kept stack, then removes the persist volumes, before it deletes the session directories", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "full-reset-"));
    fs.mkdirSync(path.join(tmp, "sessions", "s1"), { recursive: true });
    const order: string[] = [];
    // A stack kept after idle reclaim: it has no runner, only its manager.
    const kept = { stop: vi.fn(async (opts?: { removeVolumes?: boolean }) => { order.push(`stop ${String(opts?.removeVolumes)}`); }) };
    const serviceManagers = new Map([["s1", kept]]);
    const persistVolumes = {
      removeAllForReset: vi.fn(async () => {
        order.push(`volumes, sessions dir ${fs.existsSync(path.join(tmp!, "sessions")) ? "present" : "gone"}`);
      }),
    };
    const runnerRegistry = { ids: () => [], get: () => undefined, disposeAll: () => undefined } as unknown as SessionRunnerRegistry;
    await fullReset(
      { clear: () => undefined } as unknown as SessionManager,
      { clear: () => undefined } as unknown as UsageManager,
      runnerRegistry,
      tmp,
      undefined,
      undefined,
      new Map(),
      undefined,
      { serviceManagers, persistVolumes },
    );
    expect(order).toEqual(["stop true", "volumes, sessions dir present"]);
    expect(serviceManagers.size).toBe(0);
    expect(fs.existsSync(path.join(tmp, "sessions"))).toBe(false);
  });
});
