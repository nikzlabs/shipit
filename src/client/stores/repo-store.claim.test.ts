import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRepoStore } from "./repo-store.js";
import {
  _resetSessionSettingWrites,
  beginSessionSettingWrite,
} from "../utils/session-setting-writes.js";

/**
 * docs/285 req 8 — the server refuses to recycle a draft that carries settings,
 * but it can only see settings that have landed. A claim sent while a grant is
 * still saving would reuse the draft, and the late grant would then land on the
 * "new" session.
 */
describe("claimSession waits for session-settings writes", () => {
  beforeEach(() => {
    _resetSessionSettingWrites();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send the claim until an in-flight write settles", async () => {
    const fetchStub = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s2", sessionDir: "/x" }),
    }) as Response);
    vi.stubGlobal("fetch", fetchStub);

    // Warm the store's lazy import, or the wait below is too short to see a claim.
    await useRepoStore.getState().claimSession("https://github.com/o/r.git");
    fetchStub.mockClear();

    const endWrite = beginSessionSettingWrite("s1");
    const claim = useRepoStore.getState().claimSession("https://github.com/o/r.git");

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchStub).not.toHaveBeenCalled();

    endWrite();
    await expect(claim).resolves.toEqual({ sessionId: "s2", sessionDir: "/x" });
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});
