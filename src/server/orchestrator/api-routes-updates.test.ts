/**
 * The read half of `advanced.releaseChannel`'s own route
 * (docs/308-data-driven-settings, inventory.md P2).
 *
 * The declaration carries one path and one body field, and the dialog uses both
 * for the write AND for the read — so this endpoint exists to make an own-route
 * setting readable from its declaration alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerUpdateRoutes } from "./api-routes-updates.js";
import { findSetting } from "../shared/settings-catalogue/index.js";
import type * as ReleaseChannelModule from "./release-channel.js";

const channel = vi.hoisted(() => ({ readChannelOutcome: vi.fn() }));

vi.mock("./release-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ReleaseChannelModule>()),
  readChannelOutcome: channel.readChannelOutcome,
}));

const credentialStore = { getUpdateNotice: () => undefined } as never;

async function get() {
  const app = Fastify();
  await registerUpdateRoutes(app, { sseBroadcast: () => {}, credentialStore });
  const res = await app.inject({ method: "GET", url: "/api/updates/channel" });
  await app.close();
  return res;
}

beforeEach(() => {
  channel.readChannelOutcome.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

describe("GET /api/updates/channel", () => {
  it("answers the stored channel under the field the declaration names", async () => {
    channel.readChannelOutcome.mockResolvedValue({ ok: true, channel: "stable" });

    const res = await get();

    const store = findSetting("advanced.releaseChannel")!.store as { path: string; bodyField: string };
    expect(store.path).toBe("/api/updates/channel");
    expect(res.statusCode).toBe(200);
    expect(res.json()[store.bodyField]).toBe("stable");
  });

  /*
    The default channel is a real channel, so answering it for a file ShipIt
    could not read would tell a `stable` install it is on `edge` — the same
    reason `readChannelOutcome` reports the failure instead of collapsing it.
  */
  it("refuses rather than answering the default when the channel cannot be read", async () => {
    channel.readChannelOutcome.mockResolvedValue({ ok: false, error: new Error("EACCES") });

    const res = await get();

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("EACCES");
  });
});
