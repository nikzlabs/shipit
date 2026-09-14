import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerUpdateRoutes } from "../api-routes-updates.js";
import { versionAnchor } from "./update-notice.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";
import { proposeSettingChange } from "./settings-propose.js";
import { resolveSettingsProposal } from "./settings-decision.js";
import type * as UpdatesModule from "./updates.js";
import { ServiceError } from "./types.js";

/**
 * A change that was saved is not reported as refused
 * (docs/299-agent-settings-access req 4, plan.md → "Saved" has to mean saved).
 *
 * The release channel is the one operation whose write is followed by a fetch:
 * `checkForUpdates` throws its own 503 long after the channel has landed. Its
 * own file is what needs the module mock — the other write-truthfulness tests
 * must not inherit it.
 */

const updates = vi.hoisted(() => ({
  writeReleaseChannel: vi.fn<(channel: string) => Promise<void>>(),
  checkForUpdates: vi.fn(),
}));

vi.mock("./updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdatesModule>()),
  writeReleaseChannel: updates.writeReleaseChannel,
  checkForUpdates: updates.checkForUpdates,
}));

let fx: ProposalFixture;

beforeEach(() => {
  fx = proposalFixture();
  updates.writeReleaseChannel.mockReset().mockResolvedValue(undefined);
  updates.checkForUpdates.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.close();
});

async function decideChannel(): Promise<{ phase: string; outcome?: string; outcomeDetail?: string }> {
  const card = await proposeSettingChange(fx.deps, fx.sessionId, {
    key: "advanced.releaseChannel",
    valueText: "edge",
    reason: "the user asked to follow edge",
  });
  const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");
  return resolved;
}

describe("switching the release channel", () => {
  it("reports the change as applied when the update check after it fails", async () => {
    // The channel is written first, so this failure is the CHECK's. Reporting it
    // as the card's refusal told the user nothing had moved while the stored
    // channel had, and told the agent the same thing on its next turn.
    updates.checkForUpdates.mockRejectedValue(
      new ServiceError(503, "Failed to fetch updates: could not resolve github.com"),
    );

    const card = await decideChannel();

    expect(updates.writeReleaseChannel).toHaveBeenCalledWith("edge");
    expect(card.phase).toBe("applied");
    expect(card.outcome).toContain("edge");
    expect(card.outcomeDetail).toMatch(/could not check for updates/i);
  });

  it("refuses when the write itself is refused, and nothing is claimed", async () => {
    // The same 503 sentence reaches this path from the other side of the write.
    // What separates them is where it was raised, which is why the two are
    // composed rather than made one call.
    updates.writeReleaseChannel.mockRejectedValue(
      new ServiceError(503, "Host repo not available at /host-repo"),
    );

    const card = await decideChannel();

    expect(card.phase).toBe("refused");
    expect(card.outcome).toContain("Host repo not available");
    expect(updates.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports applied with no reservation when the check succeeds", async () => {
    updates.checkForUpdates.mockResolvedValue({ available: false });

    const card = await decideChannel();

    expect(card.phase).toBe("applied");
    expect(card.outcomeDetail).toBeUndefined();
  });
});

describe("POST /api/updates/channel, which answers with an update status", () => {
  it("still answers the check's own 503 and records no result", async () => {
    updates.checkForUpdates.mockRejectedValue(
      new ServiceError(503, "Failed to fetch updates: could not resolve github.com"),
    );
    const app = Fastify();
    await registerUpdateRoutes(app, { sseBroadcast: () => {}, credentialStore: fx.credentialStore });

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/channel",
      payload: { channel: "edge" },
    });
    await app.close();

    // The write no longer raises this error, so the endpoint does — its callers
    // asked for an update status and there is none.
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("Failed to fetch updates");
    expect(updates.writeReleaseChannel).toHaveBeenCalledWith("edge");
    // A check that did not run records nothing: the banner keeps saying nothing
    // is known until the next one succeeds.
    expect(fx.credentialStore.getUpdateNotice(versionAnchor(undefined))?.result).toBeUndefined();
  });
});
