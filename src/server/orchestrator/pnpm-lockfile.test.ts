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
    expect(lock.importers).toContainEqual({
      importer: ".",
      name: "vitest",
      specifier: "^3.0.0",
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

  it("records patchedDependencies and every importer directory", () => {
    const lock = parsePnpmLock(`lockfileVersion: '9.0'
patchedDependencies:
  left-pad@1.3.0:
    hash: abc
    path: patches/left-pad.patch
importers:
  .:
    dependencies: {}
  packages/api:
    dependencies: {}
`);
    expect(lock.patchedDependencies).toEqual(["left-pad@1.3.0"]);
    expect(lock.importerDirs).toEqual([".", "packages/api"]);
  });

  it("refuses a lockfile with no version rather than treating it as empty", () => {
    expect(() => parsePnpmLock("packages: {}\n")).toThrow(PnpmLockParseError);
  });
});
