import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyEmptyDepDirs, overlayMountedDepDirs } from "./overlay-dep-check.js";

function mounts(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("overlayMountedDepDirs", () => {
  it("returns dep dirs whose exact mount point is an overlay mount", () => {
    const text = mounts([
      "overlay / overlay rw,relatime,lowerdir=/a:/b,upperdir=/u,workdir=/w 0 0",
      "tmpfs /dev tmpfs rw,nosuid 0 0",
      "ext4 /workspace ext4 rw,relatime 0 0",
      "overlay /workspace/node_modules overlay rw,relatime,lowerdir=/base,upperdir=/up,workdir=/wk 0 0",
    ]);
    expect(overlayMountedDepDirs(text, "/workspace", ["node_modules"])).toEqual(["node_modules"]);
  });

  it("does not match the container root overlay or non-overlay mounts at the dep dir", () => {
    const text = mounts([
      "overlay / overlay rw 0 0",
      "ext4 /workspace/node_modules ext4 rw 0 0",
    ]);
    expect(overlayMountedDepDirs(text, "/workspace", ["node_modules"])).toEqual([]);
  });

  it("handles multiple declared dep dirs, returning only the overlay-mounted ones", () => {
    const text = mounts([
      "overlay /workspace/packages/app/node_modules overlay rw 0 0",
    ]);
    expect(
      overlayMountedDepDirs(text, "/workspace", ["node_modules", "packages/app/node_modules"]),
    ).toEqual(["packages/app/node_modules"]);
  });

  it("returns [] for empty input or no dep dirs", () => {
    expect(overlayMountedDepDirs("", "/workspace", ["node_modules"])).toEqual([]);
    expect(overlayMountedDepDirs("overlay /workspace/node_modules overlay rw 0 0", "/workspace", [])).toEqual([]);
  });
});

describe("classifyEmptyDepDirs", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-depcheck-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("flags a present-but-EMPTY default dep dir (the flag-rollback signature)", () => {
    fs.mkdirSync(path.join(workspace, "node_modules"));
    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [{ depDir: "node_modules", overlay: false }],
      hoistedAway: [],
    });
  });

  it("does NOT flag a populated dep dir (skip preserved)", () => {
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(path.join(workspace, "node_modules", "x.js"), "//");
    expect(classifyEmptyDepDirs(workspace)).toEqual({ contradicting: [], hoistedAway: [] });
  });

  it("does NOT flag an ABSENT dep dir (legit dep-less / non-Node repo)", () => {
    expect(classifyEmptyDepDirs(workspace)).toEqual({ contradicting: [], hoistedAway: [] });
  });

  it("respects the `agent.dep-dirs: []` opt-out even when a dir is empty", () => {
    fs.writeFileSync(path.join(workspace, "shipit.yaml"), "agent:\n  dep-dirs: []\n");
    fs.mkdirSync(path.join(workspace, "node_modules"));
    expect(classifyEmptyDepDirs(workspace)).toEqual({ contradicting: [], hoistedAway: [] });
  });

  it("returns only the empty dep dirs when several are declared", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - node_modules\n    - packages/app/node_modules\n",
    );
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.mkdirSync(path.join(workspace, "packages", "app", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "packages", "app", "node_modules", "dep.js"), "//");
    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [{ depDir: "node_modules", overlay: false }],
      hoistedAway: [],
    });
  });

  it("excuses an empty workspace dep dir npm hoisted into the root tree", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - node_modules\n    - server/node_modules\n    - web/node_modules\n",
    );
    writeHoistingRootTree(workspace, { "@fix/server": "server", "@fix/web": "web" });
    fs.mkdirSync(path.join(workspace, "server", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "web", "node_modules"), { recursive: true });

    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [],
      hoistedAway: ["server/node_modules", "web/node_modules"],
    });
  });

  it("flags every dep dir of a workspaces repo whose ROOT tree is empty", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - node_modules\n    - server/node_modules\n",
    );
    fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "server", "node_modules"), { recursive: true });

    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [
        { depDir: "node_modules", overlay: false },
        { depDir: "server/node_modules", overlay: false },
      ],
      hoistedAway: [],
    });
  });

  it("still flags an empty NESTED mount point the root tree says holds a tree", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - server/node_modules\n    - web/node_modules\n",
    );
    writeHoistingRootTree(
      workspace,
      { "@fix/server": "server", "@fix/web": "web" },
      { "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" } },
    );
    fs.mkdirSync(path.join(workspace, "server", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "web", "node_modules"), { recursive: true });

    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [{ depDir: "server/node_modules", overlay: false }],
      hoistedAway: ["web/node_modules"],
    });
  });

  it("still flags an empty sub-dir the root tree does NOT record as a workspace", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - node_modules\n    - game/node_modules\n",
    );
    writeHoistingRootTree(workspace, { "@fix/server": "server" });
    fs.mkdirSync(path.join(workspace, "game", "node_modules"), { recursive: true });

    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [{ depDir: "game/node_modules", overlay: false }],
      hoistedAway: [],
    });
  });

  it("does NOT excuse a declared build output that happens to sit under a workspace", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - node_modules\n    - server/dist\n",
    );
    writeHoistingRootTree(workspace, { "@fix/server": "server" });
    fs.mkdirSync(path.join(workspace, "server", "dist"), { recursive: true });

    expect(classifyEmptyDepDirs(workspace)).toEqual({
      contradicting: [{ depDir: "server/dist", overlay: false }],
      hoistedAway: [],
    });
  });
});

function writeHoistingRootTree(
  workspace: string,
  links: Record<string, string>,
  extra: Record<string, unknown> = {},
): void {
  const packages: Record<string, unknown> = { "": { name: "root", version: "1.0.0" }, ...extra };
  for (const [name, target] of Object.entries(links)) {
    packages[`node_modules/${name}`] = { resolved: target, link: true };
    packages[target] = { name, version: "1.0.0" };
  }
  const lockfile = JSON.stringify({ name: "root", lockfileVersion: 3, packages });
  const root = path.join(workspace, "node_modules");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".package-lock.json"), lockfile);
  fs.writeFileSync(path.join(workspace, "package-lock.json"), lockfile);
}
