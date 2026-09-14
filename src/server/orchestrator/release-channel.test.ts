import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CHANNEL,
  channelBranch,
  channelRef,
  pickLatestFinalTag,
  readChannel,
  readChannelOutcome,
  writeChannel,
} from "./release-channel.js";

describe("release-channel", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipit-channel-"));
    file = path.join(dir, ".release-channel");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps channels to refs and branches", () => {
    expect(channelRef("stable")).toBe("origin/stable");
    expect(channelRef("edge")).toBe("origin/main");
    expect(channelBranch("stable")).toBe("stable");
    expect(channelBranch("edge")).toBe("main");
  });

  it("defaults to edge when the file is absent", async () => {
    expect(DEFAULT_CHANNEL).toBe("edge");
    expect(await readChannel(file)).toBe("edge");
  });

  it("reads a persisted stable preference", async () => {
    await writeChannel("stable", file);
    expect(await readChannel(file)).toBe("stable");
  });

  it("round-trips edge", async () => {
    await writeChannel("edge", file);
    expect(await readChannel(file)).toBe("edge");
  });

  it("treats unknown/garbage content as the default", async () => {
    await writeFile(file, "garbage\n", "utf-8");
    expect(await readChannel(file)).toBe("edge");
  });

  it("tolerates trailing whitespace", async () => {
    await writeFile(file, "  stable  \n", "utf-8");
    expect(await readChannel(file)).toBe("stable");
  });

  describe("absent versus unreadable (docs/299-agent-settings-access req 1)", () => {
    it("answers the default channel for an absent file", async () => {
      expect(await readChannelOutcome(file)).toEqual({ ok: true, channel: "edge" });
    });

    it("says it could not tell for an unreadable file, never the default channel", async () => {
      // The default is a real channel, so an install tracking `stable` whose
      // channel file became unreadable READ as `edge` — a made-up value the
      // agent states to the user as fact.
      await writeChannel("stable", file);
      await chmod(file, 0o000);
      try {
        expect((await readChannelOutcome(file)).ok).toBe(false);
      } finally {
        await chmod(file, 0o644);
      }
    });

    it("still picks the default for callers that have to act either way", async () => {
      await writeChannel("stable", file);
      await chmod(file, 0o000);
      try {
        expect(await readChannel(file)).toBe(DEFAULT_CHANNEL);
      } finally {
        await chmod(file, 0o644);
      }
    });
  });
});

describe("pickLatestFinalTag (docs/214 Option A)", () => {
  it("returns null when there are no tags", () => {
    expect(pickLatestFinalTag([])).toBeNull();
  });

  it("picks the highest final release tag", () => {
    expect(pickLatestFinalTag(["v0.1.0", "v0.2.0", "v0.1.9"])).toBe("v0.2.0");
  });

  it("compares by semver precedence, not lexically", () => {
    expect(pickLatestFinalTag(["v0.9.0", "v0.10.0"])).toBe("v0.10.0");
    expect(pickLatestFinalTag(["v1.2.3", "v2.0.0", "v1.10.0"])).toBe("v2.0.0");
  });

  it("excludes prereleases", () => {
    expect(pickLatestFinalTag(["v1.0.0", "v1.1.0-rc.1", "v1.1.0-rc.2"])).toBe("v1.0.0");
  });

  it("returns null when only prereleases exist (fail closed)", () => {
    expect(pickLatestFinalTag(["v1.0.0-rc.1", "v1.0.0-rc.2"])).toBeNull();
  });

  it("ignores non-semver tags", () => {
    expect(pickLatestFinalTag(["latest", "release-1", "v1.0.0", "nightly"])).toBe("v1.0.0");
  });

  it("returns null when no tag is semver", () => {
    expect(pickLatestFinalTag(["latest", "nightly", "foo"])).toBeNull();
  });
});
