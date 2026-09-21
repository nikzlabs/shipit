import { describe, it, expect } from "vitest";
import zlib from "node:zlib";

import { scanTarballForBuildTriggers } from "./pnpm-install-scripts.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gzipTar,
  makeNonTarball,
  makeNpmTarball,
  paxEntry,
  tarEntry,
} from "./pnpm-tarball-test-helpers.js";

const SCRIPTED = JSON.stringify({ name: "n", version: "1.0.0", scripts: { postinstall: "x" } });
const SCRIPTLESS = JSON.stringify({ name: "n", version: "1.0.0" });

describe("scanTarballForBuildTriggers", () => {
  it("reports a package with no scripts and no build files as scriptless", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "left-pad", version: "1.3.0", scripts: { test: "node test.js" } },
      files: [{ path: "index.js", content: "module.exports = () => {};" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toEqual({ kind: "scriptless" });
  });

  it.each(["preinstall", "install", "postinstall"])(
    "names a %s script as the trigger",
    async (script) => {
      const tarball = makeNpmTarball({
        manifest: { name: "n", version: "1.0.0", scripts: { [script]: "node-gyp rebuild" } },
      });
      expect(await scanTarballForBuildTriggers(tarball)).toEqual({
        kind: "requires-build",
        trigger: `a ${script} script`,
      });
    },
  );

  it("ignores a script pnpm does not run at install time", async () => {
    // `prepare` runs for a git dependency and for the root project, never for a registry
    // tarball — and an eligible lockfile has no git entries. Counting it would cost a base to
    // most published packages for a build that never happens.
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0", scripts: { prepare: "tsc", prepublishOnly: "x" } },
    });
    expect(await scanTarballForBuildTriggers(tarball)).toEqual({ kind: "scriptless" });
  });

  it("ignores an empty install script, as pnpm's own truthiness test does", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0", scripts: { postinstall: "" } },
    });
    expect(await scanTarballForBuildTriggers(tarball)).toEqual({ kind: "scriptless" });
  });

  it("reports a binding.gyp at the package root, with no script declared at all", async () => {
    // pnpm synthesizes a node-gyp build from the file's mere presence, so a package with no
    // `scripts` block still builds.
    const tarball = makeNpmTarball({
      manifest: { name: "better-sqlite3", version: "11.0.0" },
      files: [{ path: "binding.gyp", content: "{ 'targets': [] }" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toEqual({
      kind: "requires-build",
      trigger: "a binding.gyp at its package root",
    });
  });

  it("reports a file under .hooks/, the third arm of pnpm's trigger set", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0" },
      files: [{ path: ".hooks/install", content: "#!/bin/sh\n" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toEqual({
      kind: "requires-build",
      trigger: "a file under its .hooks/ directory",
    });
  });

  it("does not read a nested binding.gyp or package.json as the package's own", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0" },
      files: [
        { path: "vendor/binding.gyp", content: "{}" },
        { path: "fixtures/package.json", content: JSON.stringify({ scripts: { install: "x" } }) },
      ],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toEqual({ kind: "scriptless" });
  });

  it("strips whatever the archive's root directory is called", async () => {
    const tarball = makeNpmTarball({
      root: "better-sqlite3-11.0.0",
      manifest: { name: "better-sqlite3", version: "11.0.0", scripts: { install: "node-gyp" } },
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("reads a path carried in a pax header rather than the header block", async () => {
    const tarball = makeNpmTarball({
      usePaxPaths: true,
      manifest: { name: "n", version: "1.0.0" },
      files: [{ path: "binding.gyp", content: "{}" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("reads a path carried in a GNU long-name entry rather than the header block", async () => {
    const tarball = makeNpmTarball({
      useGnuLongNames: true,
      manifest: { name: "n", version: "1.0.0" },
      files: [{ path: "binding.gyp", content: "{}" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("does not read a leading slash as the archive's root segment", async () => {
    const tarball = makeNpmTarball({
      absolutePaths: true,
      manifest: { name: "n", version: "1.0.0", scripts: { install: "node-gyp rebuild" } },
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("reports a binding.gyp stored as a symlink, which node-gyp still builds from", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0" },
      files: [{ path: "binding.gyp", content: "", type: "2" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("scans a package whose files run past one read of the stream", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0" },
      files: [
        { path: "dist/bundle.js", content: "x".repeat(600_000) },
        { path: "binding.gyp", content: "{}" },
      ],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it.each([
    ["bytes that are not gzip at all", Buffer.from("plain text")],
    ["a gzip stream that is not a tar archive", makeNonTarball()],
    ["a tarball with no package.json", makeNpmTarball({ manifest: null })],
    [
      "a package.json that is not valid JSON",
      makeNpmTarball({ manifest: null, files: [{ path: "package.json", content: "{oops" }] }),
    ],
  ])("reports %s as unreadable rather than scriptless", async (_label, bytes) => {
    const result = await scanTarballForBuildTriggers(bytes);
    expect(result.kind).toBe("unreadable");
  });

  it("stops at the unpacked-bytes cap rather than scanning an archive without bound", async () => {
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0" },
      files: [{ path: "big.txt", content: "y".repeat(200_000) }],
    });
    const result = await scanTarballForBuildTriggers(tarball, { maxUnpackedBytes: 1024 });
    expect(result).toMatchObject({ kind: "unreadable" });
    expect(result.kind === "unreadable" ? result.detail : "").toContain("scan cap");
  });

  it("does not decompress the whole archive once it has its answer", async () => {
    // The trigger is the first entry and the rest is 40 MiB, so a scan that only stopped at the
    // end of the stream would take visibly longer than one that stops at the verdict.
    const tarball = makeNpmTarball({
      manifest: { name: "n", version: "1.0.0", scripts: { postinstall: "node build.js" } },
      files: [{ path: "dist/huge.js", content: "z".repeat(40 * 1024 * 1024) }],
    });
    const started = Date.now();
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reads a path split across ustar's name and prefix fields", async () => {
    // A root directory long enough that `package.json` itself splits: the prefix holds the root
    // and the name holds the file, so a reader that drops the prefix sees a path with no root
    // segment at all and never finds the manifest.
    const tarball = makeNpmTarball({
      root: "r".repeat(120),
      manifest: { name: "n", version: "1.0.0", scripts: { postinstall: "node-gyp rebuild" } },
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("does not read GNU's atime field as a ustar path prefix", async () => {
    // GNU's format reuses the prefix offset for timestamps. Joining them onto the name turns
    // `binding.gyp` into `<digits>/package/binding.gyp`, which matches nothing.
    const tarball = makeNpmTarball({
      gnuFormat: true,
      manifest: { name: "n", version: "1.0.0" },
      files: [{ path: "binding.gyp", content: "{}" }],
    });
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("checks EVERY root package.json, not only the first", async () => {
    // pnpm's file map keeps the LAST entry at a path, so an archive can put a harmless manifest
    // in front of the one that actually applies.
    const tarball = gzipTar([
      ...tarEntry("package/package.json", SCRIPTLESS),
      ...tarEntry("package/package.json", SCRIPTED),
    ]);
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it.each([
    ["package/./binding.gyp"],
    ["package/lib/../binding.gyp"],
  ])("resolves %s to the package root, as pnpm does", async (entryPath) => {
    const tarball = gzipTar([
      ...tarEntry("package/package.json", SCRIPTLESS),
      ...tarEntry(entryPath, "{}"),
    ]);
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("honours a pax size record rather than walking into the payload", async () => {
    // The header declares 0 bytes while pax declares 1024, so a reader that trusts the header
    // reads the payload as tar blocks — the zero blocks there look like the end of the archive,
    // and everything after them disappears.
    const tarball = gzipTar([
      ...tarEntry("package/package.json", SCRIPTLESS),
      ...paxEntry([["size", "1024"]]),
      ...tarEntry("package/filler.bin", "\0".repeat(1024), { declaredSize: 0 }),
      ...tarEntry("package/binding.gyp", "{}"),
    ]);
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("takes the LAST pax path record, which is the one that applies", async () => {
    const tarball = gzipTar([
      ...tarEntry("package/package.json", SCRIPTLESS),
      ...paxEntry([["path", "package/safe.txt"], ["path", "package/binding.gyp"]]),
      ...tarEntry("package/safe.txt", "{}"),
    ]);
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "requires-build" });
  });

  it("refuses a pax extended header past its cap instead of skipping it", async () => {
    const tarball = gzipTar([
      ...tarEntry("package/package.json", SCRIPTLESS),
      ...paxEntry([["comment", "c".repeat(70_000)], ["path", "package/binding.gyp"]]),
      ...tarEntry("package/safe.txt", ""),
    ]);
    expect(await scanTarballForBuildTriggers(tarball)).toMatchObject({ kind: "unreadable" });
  });

  it.each([
    // The manifest entry is two blocks; cutting 100 bytes into the third stops mid-HEADER, and
    // cutting 300 bytes into the fourth stops mid-PAYLOAD. Either way a trigger could have been
    // in what is missing.
    ["a header", 2 * 512 + 100],
    ["an entry's payload", 3 * 512 + 300],
  ])("refuses an archive cut off mid-%s, even after a valid manifest", async (_label, keep) => {
    const whole = Buffer.concat([
      ...tarEntry("package/package.json", SCRIPTLESS),
      ...tarEntry("package/index.js", "x".repeat(1200)),
    ]);
    const result = await scanTarballForBuildTriggers(
      gzipTar([whole.subarray(0, keep)], { terminate: false }),
    );
    expect(result).toMatchObject({ kind: "unreadable" });
  });

  it("reads an archive GNU tar itself wrote, not only the fixture writer's", async () => {
    // The fixture writer and the reader could share a misreading of the format; GNU tar cannot.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-tar-"));
    try {
      fs.mkdirSync(path.join(dir, "package"));
      fs.writeFileSync(path.join(dir, "package", "package.json"), SCRIPTLESS);
      const out = path.join(dir, "scriptless.tgz");
      execFileSync("tar", ["-czf", out, "-C", dir, "package"]);
      expect(await scanTarballForBuildTriggers(fs.readFileSync(out))).toEqual({ kind: "scriptless" });

      fs.writeFileSync(path.join(dir, "package", "binding.gyp"), "{}");
      const built = path.join(dir, "built.tgz");
      execFileSync("tar", ["-czf", built, "-C", dir, "package"]);
      expect(await scanTarballForBuildTriggers(fs.readFileSync(built))).toMatchObject({
        kind: "requires-build",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a real gzip member produced by node's own writer", async () => {
    // Guards the scan against a fixture that only happens to match the reader: the archive is
    // re-gzipped at a different level, so nothing about the framing is shared with the default.
    const raw = zlib.gunzipSync(makeNpmTarball({ manifest: { name: "n", version: "1.0.0" } }));
    const rezipped = zlib.gzipSync(raw, { level: 1 });
    expect(await scanTarballForBuildTriggers(rezipped)).toEqual({ kind: "scriptless" });
  });
});
