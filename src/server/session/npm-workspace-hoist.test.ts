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
import { hoistedAwayDepDirs, hoistedLinkTargets } from "./npm-workspace-hoist.js";

/**
 * A hidden lockfile in the shape npm 10/11 writes for a workspaces install —
 * verified live, `node_modules/.package-lock.json` holds
 * `"node_modules/@fix/server": { "resolved": "server", "link": true }`, and, for
 * a workspace whose dependency could not hoist, a sibling entry keyed
 * `server/node_modules/lodash`.
 */
function hiddenLockfile(links: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const packages: Record<string, unknown> = { "": { name: "root", version: "1.0.0" }, ...extra };
  for (const [name, target] of Object.entries(links)) {
    packages[`node_modules/${name}`] = { resolved: target, link: true };
  }
  return JSON.stringify({ name: "root", lockfileVersion: 3, packages });
}

/**
 * The committed `package-lock.json`. Current with the checkout by construction,
 * which is what makes it the check a STALE hidden lockfile cannot pass.
 */
function manifestLockfile(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "root",
    lockfileVersion: 3,
    packages: { "": { name: "root", version: "1.0.0" }, ...extra },
  });
}

describe("hoistedLinkTargets", () => {
  it("returns the package paths npm recorded as links with no nested tree", () => {
    const text = hiddenLockfile({ "@fix/server": "server", "@fix/web": "packages/web" });
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set(["server", "packages/web"]));
  });

  it("ignores ordinary reified packages — only `link: true` counts", () => {
    const text = hiddenLockfile({}, { "node_modules/ms": { version: "2.1.3", resolved: "https://x/ms" } });
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  /**
   * The half a link alone does not prove. Verified against npm 11.12.1: a root
   * on `lodash@4` with a workspace `server` on `lodash@3` writes BOTH the link
   * and `server/node_modules/lodash@3.10.1` into the root hidden lockfile, and
   * creates `server/node_modules` on disk. The sibling `web`, with no conflict,
   * gets the link, no nested entry, and no directory.
   */
  it("drops a linked target npm gave a nested tree of its own", () => {
    const text = hiddenLockfile(
      { "@fix/server": "server", "@fix/web": "web" },
      { "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" } },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set(["web"]));
  });

  it("attributes a doubly-nested entry to the target that owns it", () => {
    const text = hiddenLockfile(
      { "@fix/server": "server" },
      { "server/node_modules/a/node_modules/b": { version: "1.0.0" } },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  it("does not misattribute a target whose own path contains `node_modules`", () => {
    // Matching by prefix rather than by splitting on the first `/node_modules/`.
    // Splitting would name `packages` as the owner here and wrongly KEEP the
    // target, which the config parser permits a repo to declare.
    const text = hiddenLockfile(
      { "@fix/server": "packages/node_modules/server" },
      { "packages/node_modules/server/node_modules/lodash": { version: "3.10.1" } },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  it("does not let a SIBLING prefix disqualify a target", () => {
    // `server-tools` starts with `server` textually; the trailing `/node_modules/`
    // in the prefix is what keeps them distinct.
    const text = hiddenLockfile(
      { "@fix/server": "server", "@fix/tools": "server-tools" },
      { "server-tools/node_modules/lodash": { version: "3.10.1" } },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set(["server"]));
  });

  /**
   * Regression for the second review's P1. An earlier cut filtered nested entries
   * through the staleness check's `isRequired`, which excludes optional, peer and
   * platform-restricted packages. That predicate is built for the MANIFEST
   * lockfile, where a package npm never installed still appears. The HIDDEN
   * lockfile lists ONLY what is on disk — verified: an optional dep skipped for a
   * platform mismatch is absent from it entirely, while the manifest still lists
   * it with `optional: true, os: ["darwin"]`. So an entry here means a real
   * directory, whatever flags it carries, and filtering could only excuse a dep
   * dir that genuinely holds something. This repository's own hidden lockfile has
   * 21 entries those exclusions would have skipped.
   */
  it("drops a target whose nested entries are optional, peer or platform-restricted", () => {
    const text = hiddenLockfile(
      { "@fix/server": "server" },
      {
        "server/node_modules/fsevents": { version: "2.3.3", optional: true, os: ["darwin"] },
        "server/node_modules/react": { version: "19.2.4", peer: true },
      },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  /**
   * Regression for the second review's other P1 — a STALE hidden lockfile. The
   * ancestor tree need not be a declared dep dir, so nothing else proves its
   * record describes the install that just ran: an older commit's root install
   * recorded the link with everything hoisted, and a laundered install over a
   * newer commit leaves that record in place. The manifest lockfile cannot drift
   * that way (it is committed, current with the checkout) and names the nested
   * tree the current commit requires.
   */
  it("refuses a target the MANIFEST lockfile says owns a nested tree", () => {
    const stale = hiddenLockfile({ "@fix/server": "server", "@fix/web": "web" });
    const current = manifestLockfile({
      "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" },
    });
    expect(hoistedLinkTargets(stale, current)).toEqual(new Set(["web"]));
  });

  it("refuses everything when the manifest lockfile is missing or unreadable", () => {
    // Without a current statement there is nothing to check a possibly-stale
    // record against, so the safe direction is to excuse nothing.
    const text = hiddenLockfile({ "@fix/server": "server" });
    expect(hoistedLinkTargets(text, "")).toEqual(new Set());
    expect(hoistedLinkTargets(text, "not json")).toEqual(new Set());
  });

  it("normalizes `./`-prefixed, `file:`-prefixed and trailing-slash targets", () => {
    // Normalized into the same shape `agent.dep-dirs` entries are, so the two
    // sides compare as strings without either having to guess the other's form.
    const text = hiddenLockfile({ a: "./server/", b: "file:packages/web", c: "web" });
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set(["server", "packages/web", "web"]));
  });

  it("drops targets that cannot name a dep dir inside the workspace", () => {
    const text = hiddenLockfile({ a: "/abs/server", b: "../outside", c: "https://x/y", d: "" });
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  it("returns an empty set for unparseable or non-v2 lockfiles", () => {
    // The direction that exempts NOTHING. A lockfile ShipIt cannot read is never
    // a licence to accept an empty dep dir.
    expect(hoistedLinkTargets("not json", manifestLockfile())).toEqual(new Set());
    expect(hoistedLinkTargets("null", manifestLockfile())).toEqual(new Set());
    expect(hoistedLinkTargets(JSON.stringify({ dependencies: { ms: {} } }), manifestLockfile())).toEqual(new Set());
    expect(hoistedLinkTargets(JSON.stringify({ packages: [] }), manifestLockfile())).toEqual(new Set());
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

  /**
   * Populate `<dir>` with both lockfiles an npm install leaves behind: the hidden
   * record of what was reified, and the committed manifest the exemption checks
   * it against. `manifestExtra` defaults to matching the hidden record, which is
   * what a real install produces — a test that wants them to DISAGREE (the stale
   * record case) passes it explicitly.
   */
  function writeTree(
    dir: string,
    links: Record<string, string>,
    extra: Record<string, unknown> = {},
    manifestExtra: Record<string, unknown> = extra,
  ): void {
    const base = path.join(workspace, dir);
    const nm = path.join(base, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, ".package-lock.json"), hiddenLockfile(links, extra));
    fs.writeFileSync(path.join(base, "package-lock.json"), manifestLockfile(manifestExtra));
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

  /**
   * The docs/183 mode 1 / mode 2 case the FIRST cut of this exemption got wrong:
   * only a NESTED dep dir is declared, so the ancestor tree survives in the clone
   * and its record is readable even though the mount point is empty. The record
   * is exactly what decides it — a conflicting nested dependency means the empty
   * mount point IS a contradiction, and the reinstall must still fire.
   */
  it("does not excuse an empty mount point npm's record says holds a nested tree", () => {
    writeTree(".", { "@fix/server": "server", "@fix/web": "web" }, {
      "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" },
    });
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules", "web/node_modules"])).toEqual([
      "web/node_modules",
    ]);
  });

  it("does not excuse it when only the MANIFEST names the nested tree (stale record)", () => {
    // The hidden record is from an older install and still says "fully hoisted";
    // the committed manifest, current with the checkout, says otherwise.
    writeTree(
      ".",
      { "@fix/server": "server", "@fix/web": "web" },
      {},
      { "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" } },
    );
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules", "web/node_modules"])).toEqual([
      "web/node_modules",
    ]);
  });

  it("tolerates an unreadable ancestor lockfile by excusing nothing", () => {
    const nm = path.join(workspace, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, ".package-lock.json"), "{ truncated");
    fs.writeFileSync(path.join(workspace, "package-lock.json"), manifestLockfile());
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules"])).toEqual([]);
  });

  it("excuses nothing when the ancestor has no manifest lockfile beside it", () => {
    // Only the hidden record exists (an install run with --no-package-lock, or a
    // tree left behind by something else). Nothing current to check it against.
    const nm = path.join(workspace, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, ".package-lock.json"), hiddenLockfile({ "@fix/server": "server" }));
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules"])).toEqual([]);
  });
});
