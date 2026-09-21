import { describe, it, expect } from "vitest";

import { parsePnpmLock, splitLockKey, PnpmLockParseError } from "./pnpm-lockfile.js";

const REGISTRY_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@types/node':
        specifier: 20.11.0
        version: 20.11.0
      left-pad:
        specifier: 1.3.0
        version: 1.3.0
    devDependencies:
      vitest:
        specifier: ^3.0.0
        version: 3.0.1

packages:

  '@types/node@20.11.0':
    resolution: {integrity: sha512-aaa==}

  left-pad@1.3.0:
    resolution: {integrity: sha512-bbb==}
    deprecated: use String.prototype.padStart()

  vitest@3.0.1:
    resolution: {integrity: sha512-ccc==}

snapshots:

  '@types/node@20.11.0': {}

  left-pad@1.3.0: {}

  vitest@3.0.1: {}
`;

describe("splitLockKey", () => {
  it("splits a scoped name from its version", () => {
    expect(splitLockKey("@babel/core@7.24.0")).toEqual({ name: "@babel/core", version: "7.24.0" });
  });

  it("drops the peer-dependency suffix pnpm appends to a key", () => {
    expect(splitLockKey("react-dom@18.2.0(react@18.2.0)")).toEqual({
      name: "react-dom",
      version: "18.2.0",
    });
  });

  it("rejects a key with no version", () => {
    expect(splitLockKey("left-pad")).toBeNull();
  });
});

describe("parsePnpmLock", () => {
  it("reads registry packages, their digests and importer specifiers", () => {
    const lock = parsePnpmLock(REGISTRY_LOCK);
    expect(lock.lockfileVersion).toBe("9.0");
    expect(lock.packages.map((p) => p.key)).toEqual([
      "@types/node@20.11.0",
      "left-pad@1.3.0",
      "vitest@3.0.1",
    ]);
    expect(lock.packages.every((p) => p.kind === "registry")).toBe(true);
    expect(lock.packages[0].integrity).toBe("sha512-aaa==");
    // Both halves of the edge: an ordinary specifier can resolve to a local link.
    expect(lock.importers).toContainEqual({
      importer: ".",
      name: "vitest",
      specifier: "^3.0.0",
      resolved: "3.0.1",
    });
    expect(lock.importerDirs).toEqual(["."]);
  });

  it("classifies a git, directory or tarball resolution as unverifiable, not as registry", () => {
    const lock = parsePnpmLock(`lockfileVersion: '9.0'
packages:
  gitdep@1.0.0:
    resolution: {type: git, repo: git@github.com:acme/x.git, commit: abc}
  localdep@1.0.0:
    resolution: {type: directory, directory: packages/local}
  tardep@1.0.0:
    resolution: {tarball: https://evil.test/x.tgz, integrity: sha512-zzz==}
`);
    expect(lock.packages.map((p) => [p.key, p.kind])).toEqual([
      ["gitdep@1.0.0", "git"],
      ["localdep@1.0.0", "directory"],
      ["tardep@1.0.0", "tarball"],
    ]);
  });

  it("collapses peer-suffixed keys onto the one published tarball", () => {
    const lock = parsePnpmLock(`lockfileVersion: '9.0'
packages:
  react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-ddd==}
  react-dom@18.2.0(react@18.3.0):
    resolution: {integrity: sha512-ddd==}
`);
    expect(lock.packages).toHaveLength(1);
    expect(lock.packages[0].key).toBe("react-dom@18.2.0");
  });

  it("records every snapshot dependency edge, where a transitive link shows up", () => {
    const lock = parsePnpmLock(`lockfileVersion: '9.0'
snapshots:
  left-pad@1.3.0:
    dependencies:
      helper: link:packages/helper
    optionalDependencies:
      fsevents: 2.3.3
`);
    expect(lock.snapshotEdges).toEqual([
      { from: "left-pad@1.3.0", name: "helper", resolved: "link:packages/helper" },
      { from: "left-pad@1.3.0", name: "fsevents", resolved: "2.3.3" },
    ]);
  });

  it("records patchedDependencies and every importer directory", () => {
    // Both shapes: pnpm 12 records the patch hash alone, pnpm <= 11 records `{hash, path}`, and
    // both write `lockfileVersion: '9.0'` — so the hash has to be read out of either.
    const lock = parsePnpmLock(`lockfileVersion: '9.0'
patchedDependencies:
  left-pad@1.3.0: abc
  right-pad@1.0.0:
    hash: def
    path: patches/right-pad.patch
  no-hash@1.0.0: {}
importers:
  .:
    dependencies: {}
  packages/api:
    dependencies: {}
`);
    expect(lock.patchedDependencies).toEqual([
      { key: "left-pad@1.3.0", hash: "abc" },
      { key: "right-pad@1.0.0", hash: "def" },
      { key: "no-hash@1.0.0", hash: null },
    ]);
    expect(lock.importerDirs).toEqual([".", "packages/api"]);
  });

  it("refuses a lockfile with no version rather than treating it as empty", () => {
    expect(() => parsePnpmLock("packages: {}\n")).toThrow(PnpmLockParseError);
  });
});
