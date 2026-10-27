import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BAKED_PLAYWRIGHT_BROWSERS_DIR,
  SESSION_PLAYWRIGHT_BROWSERS_DIR,
  linkBakedPlaywrightBrowsers,
} from "./playwright-browsers.js";

let root: string;
let baked: string;
let target: string;

/** A build as Playwright installs it: a directory with its executable and completion marker. */
function bakeBuild(name: string): void {
  fs.mkdirSync(path.join(baked, name, "chrome-linux64"), { recursive: true });
  fs.writeFileSync(path.join(baked, name, "chrome-linux64", "chrome"), "binary");
  fs.writeFileSync(path.join(baked, name, "INSTALLATION_COMPLETE"), "");
}

function bakeLink(file: string, packageDir: string): void {
  fs.mkdirSync(path.join(baked, ".links"), { recursive: true });
  fs.writeFileSync(path.join(baked, ".links", file), packageDir);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-browsers-test-"));
  baked = path.join(root, "opt", "playwright-browsers");
  target = path.join(root, "session-state", "playwright-browsers");
  fs.mkdirSync(baked, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the browser stores", () => {
  it("gives the session a store in its own persistent state, apart from the image's", () => {
    expect(BAKED_PLAYWRIGHT_BROWSERS_DIR).toBe("/opt/playwright-browsers");
    expect(SESSION_PLAYWRIGHT_BROWSERS_DIR).toBe("/session-state/playwright-browsers");
  });
});

describe("linkBakedPlaywrightBrowsers", () => {
  it("makes every baked build launchable from the session's store", () => {
    bakeBuild("chromium-1247");
    bakeBuild("chromium_headless_shell-1248");
    bakeBuild("ffmpeg-1013");

    const linked = linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked);

    expect(linked?.sort()).toEqual(["chromium-1247", "chromium_headless_shell-1248", "ffmpeg-1013"]);
    for (const build of linked ?? []) {
      expect(fs.readlinkSync(path.join(target, build))).toBe(path.join(baked, build));
      expect(fs.existsSync(path.join(target, build, "INSTALLATION_COMPLETE"))).toBe(true);
    }
    expect(fs.readFileSync(path.join(target, "chromium_headless_shell-1248", "chrome-linux64", "chrome"), "utf8"))
      .toBe("binary");
  });

  it("records the baked packages, so a project's `playwright install` does not collect their builds", () => {
    bakeBuild("chromium-1248");
    bakeLink("7e452c84", "/opt/agent-cli/node_modules/playwright-core");
    bakeLink("a1b2c3d4", "/opt/agent-cli/node_modules/playwright-stable");

    linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked);

    expect(fs.readdirSync(path.join(target, ".links")).sort()).toEqual(["7e452c84", "a1b2c3d4"]);
    expect(fs.readFileSync(path.join(target, ".links", "a1b2c3d4"), "utf8"))
      .toBe("/opt/agent-cli/node_modules/playwright-stable");
    // The `.links` directory is Playwright's bookkeeping, not a build to link.
    expect(fs.lstatSync(path.join(target, ".links")).isSymbolicLink()).toBe(false);
  });

  it("links nothing again on the next container start", () => {
    bakeBuild("chromium-1248");
    linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked);

    expect(linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked)).toEqual([]);
  });

  it("keeps a build the project installed itself, and its other installs", () => {
    bakeBuild("chromium_headless_shell-1248");
    fs.mkdirSync(path.join(target, "chromium_headless_shell-1248"), { recursive: true });
    fs.writeFileSync(path.join(target, "chromium_headless_shell-1248", "own"), "");
    fs.mkdirSync(path.join(target, "chromium_headless_shell-1234"), { recursive: true });

    expect(linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked)).toEqual([]);
    expect(fs.lstatSync(path.join(target, "chromium_headless_shell-1248")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(target, "chromium_headless_shell-1248", "own"))).toBe(true);
    expect(fs.existsSync(path.join(target, "chromium_headless_shell-1234"))).toBe(true);
  });

  it("restores a link that a project's `playwright uninstall --all` removed", () => {
    bakeBuild("chromium-1248");
    linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked);
    fs.unlinkSync(path.join(target, "chromium-1248"));

    expect(linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked)).toEqual(["chromium-1248"]);
  });

  it("follows a build the image's store holds as a link", () => {
    fs.mkdirSync(path.join(root, "elsewhere", "chromium-1247"), { recursive: true });
    fs.symlinkSync(path.join(root, "elsewhere", "chromium-1247"), path.join(baked, "chromium-1247"));

    expect(linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, baked)).toEqual(["chromium-1247"]);
  });

  it.each([
    { name: "no browsers path", env: (): NodeJS.ProcessEnv => ({}) },
    { name: "the image's own store", env: (): NodeJS.ProcessEnv => ({ PLAYWRIGHT_BROWSERS_PATH: baked }) },
  ])("prepares nothing for $name", ({ env }) => {
    bakeBuild("chromium-1248");
    const vars = env();

    expect(linkBakedPlaywrightBrowsers(vars, baked)).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
    expect(vars).toEqual(env());
  });

  it("prepares nothing in an image with no baked store", () => {
    expect(linkBakedPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: target }, path.join(root, "missing"))).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("falls back to the image's store when the session's cannot be created", () => {
    bakeBuild("chromium-1248");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "a file where the store belongs");
    const env: NodeJS.ProcessEnv = { PLAYWRIGHT_BROWSERS_PATH: target };

    expect(linkBakedPlaywrightBrowsers(env, baked)).toBeNull();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(baked);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`could not create ${target}`));
  });

  it("keeps the session's store, and the project's own builds in it, when a later step fails", () => {
    bakeBuild("chromium-1248");
    bakeLink("7e452c84", "/opt/agent-cli/node_modules/playwright-core");
    fs.mkdirSync(path.join(target, "chromium_headless_shell-1243"), { recursive: true });
    // A directory where the record belongs makes the copy fail.
    fs.mkdirSync(path.join(target, ".links", "7e452c84"), { recursive: true });
    const env: NodeJS.ProcessEnv = { PLAYWRIGHT_BROWSERS_PATH: target };

    expect(linkBakedPlaywrightBrowsers(env, baked)).toEqual(["chromium-1248"]);
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(target);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not link every baked build"));
  });
});
