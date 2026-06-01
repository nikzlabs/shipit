import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CHANNEL,
  channelBranch,
  channelRef,
  readChannel,
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
});
