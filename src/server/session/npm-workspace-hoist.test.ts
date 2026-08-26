/**
 * planning#480 — the npm-hoist exemption that makes `overlay-dep-check`'s
 * absence hatch reachable again under the overlay dep store.
 *
 * The parsing rule (`workspaceLinkTargets`) is pure and covered first. The
 * ancestor walk (`hoistedAwayDepDirs`) is fs-coupled and exercised against real
 * temp workspaces, because the thing being asserted IS "which file did it read".
 *
 * Every negative case below is a guarantee this exemption must not weaken: a
 * laundered install exit stays fatal (docs/272), and a freshly-mounted or
 * freshly-unmounted overlay still forces a reinstall (docs/183 modes 1 and 2).
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hoistedAwayDepDirs, workspaceLinkTargets } from "./npm-workspace-hoist.js";

/**
 * A hidden lockfile in the shape npm 10 writes for a workspaces install —
 * verified live, `node_modules/.package-lock.json` holds
 * `"node_modules/@fix/server": { "resolved": "server", "link": true }`.
 */
function hiddenLockfile(links: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const packages: Record<string, unknown> = { "": { name: "root", version: "1.0.0" }, ...extra };
  for (const [name, target] of Object.entries(links)) {
    packages[`node_modules/${name}`] = { resolved: target, link: true };
  }
  return JSON.stringify({ name: "root", lockfileVersion: 3, packages });
}

describe("workspaceLinkTargets", () => {
  it("returns the workspace paths npm recorded as links", () => {
    const text = hiddenLockfile({ "@fix/server": "server", "@fix/web": "packages/web" });
    expect(workspaceLinkTargets(text)).toEqual(new Set(["server", "packages/web"]));
  });

  it("ignores ordinary reified packages — only `link: true` counts", () => {
    const text = hiddenLockfile({}, { "node_modules/ms": { version: "2.1.3", resolved: "https://x/ms" } });
    expect(workspaceLinkTargets(text)).toEqual(new Set());
  });

  it("normalizes `./`-prefixed, `file:`-prefixed and trailing-slash targets", () => {
    // Normalized into the same shape `agent.dep-dirs` entries are, so the two
    // sides compare as strings without either having to guess the other's form.
    const text = hiddenLockfile({ a: "./server/", b: "file:packages/web", c: "web" });
    expect(workspaceLinkTargets(text)).toEqual(new Set(["server", "packages/web", "web"]));
  });

  it("drops targets that cannot name a dep dir inside the workspace", () => {
    const text = hiddenLockfile({ a: "/abs/server", b: "../outside", c: "https://x/y", d: "" });
    expect(workspaceLinkTargets(text)).toEqual(new Set());
  });

  it("returns an empty set for unparseable or non-v2 lockfiles", () => {
    // The direction that exempts NOTHING. A lockfile ShipIt cannot read is never
    // a licence to accept an empty dep dir.
    expect(workspaceLinkTargets("not json")).toEqual(new Set());
    expect(workspaceLinkTargets("null")).toEqual(new Set());
    expect(workspaceLinkTargets(JSON.stringify({ dependencies: { ms: {} } }))).toEqual(new Set());
    expect(workspaceLinkTargets(JSON.stringify({ packages: [] }))).toEqual(new Set());
  });
});

describe("hoistedAwayDepDirs", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-hoist-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Populate `<dir>/node_modules` with npm's record of the workspaces it linked. */
  function writeTree(dir: string, links: Record<string, string>): void {
    const nm = path.join(workspace, dir, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, ".package-lock.json"), hiddenLockfile(links));
  }

  it("excuses a workspace dep dir the root tree records as a link", () => {
    writeTree(".", { "@fix/server": "server", "@fix/web": "web" });
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules", "web/node_modules"])).toEqual([
      "server/node_modules",
      "web/node_modules",
    ]);
  });

  it("excuses a NESTED workspace, whose `resolved` is relative to the tree that wrote it", () => {
    writeTree(".", { "@fix/web": "packages/web" });
    expect(hoistedAwayDepDirs(workspace, ["packages/web/node_modules"])).toEqual([
      "packages/web/node_modules",
    ]);
  });

  it("excuses a nested workspace reified by an INTERMEDIATE tree, not the root", () => {
    // A monorepo-inside-a-monorepo: `packages/` runs its own install, so the link
    // it recorded says `web`, not `packages/web`. The walk resolves the dep dir
    // relative to whichever ancestor wrote the record.
    writeTree("packages", { "@fix/web": "web" });
    expect(hoistedAwayDepDirs(workspace, ["packages/web/node_modules"])).toEqual([
      "packages/web/node_modules",
    ]);
  });

  it("excuses nothing when no ancestor tree holds a record (the laundered-exit case)", () => {
    // docs/272's field shape: `npm ci … || [ -x node_modules/.bin/vite ]` exits 0
    // having installed nothing, so there is no hidden lockfile anywhere and the
    // empty dirs stay the failure they are.
    expect(hoistedAwayDepDirs(workspace, ["node_modules", "game/node_modules"])).toEqual([]);
  });

  it("never excuses a root-level dep dir, whatever the record says", () => {
    // A root `node_modules` has no ancestor package to hoist into — and it is the
    // dir whose emptiness both checks exist to catch.
    writeTree(".", { "@fix/server": "server" });
    expect(hoistedAwayDepDirs(workspace, ["node_modules"])).toEqual([]);
  });

  it("never excuses a dir that is not named `node_modules`", () => {
    // docs/183 invites declaring a build output. npm's hoisting rule says nothing
    // about `dist/`, so it cannot excuse one.
    writeTree(".", { "@fix/server": "server" });
    expect(hoistedAwayDepDirs(workspace, ["server/dist"])).toEqual([]);
  });

  it("does not excuse a sibling directory the root tree does not name", () => {
    // The other laundering route: a real root install beside a laundered
    // sub-install. `game` is not a workspace the root reified, so its empty dep
    // dir is unexplained and stays fatal.
    writeTree(".", { "@fix/server": "server" });
    expect(hoistedAwayDepDirs(workspace, ["game/node_modules"])).toEqual([]);
  });

  it("does not excuse a workspace whose link the install did NOT reify", () => {
    // A filtered install (`npm install --workspace=web`) leaves `server` out of
    // the hidden lockfile even though the visible `package-lock.json` declares
    // it. Reading npm's record of what it ACTUALLY reified — not the manifest's
    // intent — is what makes the exemption evidence rather than assumption.
    writeTree(".", { "@fix/web": "web" });
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules", "web/node_modules"])).toEqual([
      "web/node_modules",
    ]);
  });

  it("tolerates an unreadable ancestor lockfile by excusing nothing", () => {
    const nm = path.join(workspace, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, ".package-lock.json"), "{ truncated");
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules"])).toEqual([]);
  });
});
