import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hoistedAwayDepDirs, hoistedLinkTargets } from "./npm-workspace-hoist.js";

function hiddenLockfile(links: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const packages: Record<string, unknown> = { "": { name: "root", version: "1.0.0" }, ...extra };
  for (const [name, target] of Object.entries(links)) {
    packages[`node_modules/${name}`] = { resolved: target, link: true };
  }
  return JSON.stringify({ name: "root", lockfileVersion: 3, packages });
}

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
    const text = hiddenLockfile(
      { "@fix/server": "packages/node_modules/server" },
      { "packages/node_modules/server/node_modules/lodash": { version: "3.10.1" } },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  it("does not let a SIBLING prefix disqualify a target", () => {
    const text = hiddenLockfile(
      { "@fix/server": "server", "@fix/tools": "server-tools" },
      { "server-tools/node_modules/lodash": { version: "3.10.1" } },
    );
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set(["server"]));
  });

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

  it("refuses a target the MANIFEST lockfile says owns a nested tree", () => {
    const stale = hiddenLockfile({ "@fix/server": "server", "@fix/web": "web" });
    const current = manifestLockfile({
      "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" },
    });
    expect(hoistedLinkTargets(stale, current)).toEqual(new Set(["web"]));
  });

  it("refuses everything when the manifest lockfile is missing or unreadable", () => {
    const text = hiddenLockfile({ "@fix/server": "server" });
    expect(hoistedLinkTargets(text, "")).toEqual(new Set());
    expect(hoistedLinkTargets(text, "not json")).toEqual(new Set());
  });

  it("normalizes `./`-prefixed, `file:`-prefixed and trailing-slash targets", () => {
    const text = hiddenLockfile({ a: "./server/", b: "file:packages/web", c: "web" });
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set(["server", "packages/web", "web"]));
  });

  it("drops targets that cannot name a dep dir inside the workspace", () => {
    const text = hiddenLockfile({ a: "/abs/server", b: "../outside", c: "https://x/y", d: "" });
    expect(hoistedLinkTargets(text, manifestLockfile())).toEqual(new Set());
  });

  it("returns an empty set for unparseable or non-v2 lockfiles", () => {
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
    writeTree("packages", { "@fix/web": "web" });
    expect(hoistedAwayDepDirs(workspace, ["packages/web/node_modules"])).toEqual([
      "packages/web/node_modules",
    ]);
  });

  it("excuses nothing when no ancestor tree holds a record (the laundered-exit case)", () => {
    expect(hoistedAwayDepDirs(workspace, ["node_modules", "game/node_modules"])).toEqual([]);
  });

  it("never excuses a root-level dep dir, whatever the record says", () => {
    writeTree(".", { "@fix/server": "server" });
    expect(hoistedAwayDepDirs(workspace, ["node_modules"])).toEqual([]);
  });

  it("never excuses a dir that is not named `node_modules`", () => {
    writeTree(".", { "@fix/server": "server" });
    expect(hoistedAwayDepDirs(workspace, ["server/dist"])).toEqual([]);
  });

  it("does not excuse a sibling directory the root tree does not name", () => {
    writeTree(".", { "@fix/server": "server" });
    expect(hoistedAwayDepDirs(workspace, ["game/node_modules"])).toEqual([]);
  });

  it("does not excuse a workspace whose link the install did NOT reify", () => {
    writeTree(".", { "@fix/web": "web" });
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules", "web/node_modules"])).toEqual([
      "web/node_modules",
    ]);
  });

  it("does not excuse an empty mount point npm's record says holds a nested tree", () => {
    writeTree(".", { "@fix/server": "server", "@fix/web": "web" }, {
      "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" },
    });
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules", "web/node_modules"])).toEqual([
      "web/node_modules",
    ]);
  });

  it("does not excuse it when only the MANIFEST names the nested tree (stale record)", () => {
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
    const nm = path.join(workspace, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, ".package-lock.json"), hiddenLockfile({ "@fix/server": "server" }));
    expect(hoistedAwayDepDirs(workspace, ["server/node_modules"])).toEqual([]);
  });
});
