// docs/335-project-playwright-browsers — the image bakes browser builds into a read-only
// store: the built-in browser's own build and the pinned stable Playwright release's.
// Playwright reads ONE directory, and `playwright install` needs to write it, so a
// session's processes get a writable directory that links every baked build back in.

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_SESSION_STATE_DIR } from "./fs-constants.js";
import { getErrorMessage } from "./utils.js";

export const BAKED_PLAYWRIGHT_BROWSERS_DIR = "/opt/playwright-browsers";

/** A session's `PLAYWRIGHT_BROWSERS_PATH`: private, writable, and kept across container restarts. */
export const SESSION_PLAYWRIGHT_BROWSERS_DIR = path.join(CONTAINER_SESSION_STATE_DIR, "playwright-browsers");

// Playwright's install GC keeps a build only while a package recorded here still names it.
const LINKS_DIR = ".links";

/**
 * Worker entry point, run before anything can start Playwright. Keyed off
 * `PLAYWRIGHT_BROWSERS_PATH` like the npm cache split, so it prepares the directory
 * Playwright will read and nothing else. Returns the builds it linked.
 */
export function linkBakedPlaywrightBrowsers(
  env: NodeJS.ProcessEnv = process.env,
  bakedDir: string = BAKED_PLAYWRIGHT_BROWSERS_DIR,
): string[] | null {
  const target = env.PLAYWRIGHT_BROWSERS_PATH;
  if (!target || path.resolve(target) === path.resolve(bakedDir) || !fs.existsSync(bakedDir)) return null;
  try {
    fs.mkdirSync(path.join(target, LINKS_DIR), { recursive: true });
  } catch (err) {
    // With no store at all, the read-only one at least launches the baked builds.
    // The worker's children inherit this.
    console.warn(
      `[playwright-browsers] could not create ${target} (${getErrorMessage(err)}); `
        + `using the read-only ${bakedDir}, where \`playwright install\` cannot write`,
    );
    env.PLAYWRIGHT_BROWSERS_PATH = bakedDir;
    return null;
  }
  const linked: string[] = [];
  try {
    linkBuilds(target, bakedDir, linked);
  } catch (err) {
    console.warn(`[playwright-browsers] could not link every baked build into ${target}: ${getErrorMessage(err)}`);
  }
  if (linked.length > 0) console.log(`[playwright-browsers] linked into ${target}: ${linked.join(", ")}`);
  return linked;
}

function linkBuilds(target: string, bakedDir: string, linked: string[]): void {
  const builds = fs.readdirSync(bakedDir)
    .filter((name) => !name.startsWith(".") && fs.statSync(path.join(bakedDir, name)).isDirectory());
  for (const build of builds) {
    const link = path.join(target, build);
    const source = path.join(bakedDir, build);
    const existing = lstatOrNull(link);
    // A real directory is the project's own install of that build; leave it.
    if (existing && !existing.isSymbolicLink()) continue;
    if (existing && fs.readlinkSync(link) === source) continue;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(source, link);
    linked.push(build);
  }

  const bakedLinks = path.join(bakedDir, LINKS_DIR);
  for (const name of fs.existsSync(bakedLinks) ? fs.readdirSync(bakedLinks) : []) {
    fs.copyFileSync(path.join(bakedLinks, name), path.join(target, LINKS_DIR, name));
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}
