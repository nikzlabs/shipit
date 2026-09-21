import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  conventionalTarballPath,
  sha512Integrity,
  stageVerifiedRegistry,
  tarballFileName,
  type FetchLike,
} from "./pnpm-base-registry.js";

const REGISTRY = "https://registry.example.test/";
const BUILDER = "http://127.0.0.1:4873/";

function bytesFor(name: string): Buffer {
  return Buffer.from(`tarball bytes for ${name}`);
}

interface FakeRegistry {
  fetchImpl: FetchLike;
  urls: string[];
  /** Overrides the digest a packument publishes, leaving the bytes alone. */
  publishedIntegrity: Map<string, string>;
  /** Replaces the bytes served, leaving the packument alone. */
  servedBytes: Map<string, Buffer>;
  missingVersions: Set<string>;
}

function fakeRegistry(packages: { name: string; version: string }[]): FakeRegistry {
  const urls: string[] = [];
  const publishedIntegrity = new Map<string, string>();
  const servedBytes = new Map<string, Buffer>();
  const missingVersions = new Set<string>();

  const fetchImpl: FetchLike = (url) => {
    urls.push(url);
    const tarball = packages.find(
      (p) => url === `${REGISTRY.replace(/\/$/, "")}${conventionalTarballPath(p.name, p.version)}`,
    );
    if (tarball) {
      const key = `${tarball.name}@${tarball.version}`;
      const body = servedBytes.get(key) ?? bytesFor(key);
      return Promise.resolve(
        new Response(new Uint8Array(body), { status: 200 }) as unknown as Response,
      );
    }
    const name = decodeURIComponent(url.slice(REGISTRY.replace(/\/$/, "").length + 1));
    const versions: Record<string, unknown> = {};
    for (const p of packages.filter((p) => p.name === name)) {
      const key = `${p.name}@${p.version}`;
      if (missingVersions.has(key)) continue;
      versions[p.version] = {
        dist: {
          integrity: publishedIntegrity.get(key) ?? sha512Integrity(bytesFor(key)),
          tarball: `${REGISTRY.replace(/\/$/, "")}${conventionalTarballPath(p.name, p.version)}`,
        },
      };
    }
    if (Object.keys(versions).length === 0 && !packages.some((p) => p.name === name)) {
      return Promise.resolve(new Response("{}", { status: 404 }) as unknown as Response);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ name, versions }), { status: 200 }) as unknown as Response,
    );
  };

  return { fetchImpl, urls, publishedIntegrity, servedBytes, missingVersions };
}

describe("stageVerifiedRegistry", () => {
  let destDir: string;
  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-reg-"));
  });
  afterEach(() => fs.rmSync(destDir, { recursive: true, force: true }));

  const LEFT_PAD = { name: "left-pad", version: "1.3.0" };
  const SCOPED = { name: "@types/node", version: "20.11.0" };

  function requestFor(p: { name: string; version: string }): {
    key: string;
    name: string;
    version: string;
    integrity: string;
  } {
    const key = `${p.name}@${p.version}`;
    return { key, name: p.name, version: p.version, integrity: sha512Integrity(bytesFor(key)) };
  }

  it("stages verified tarballs with a packument that addresses the builder's own registry", async () => {
    const reg = fakeRegistry([LEFT_PAD, SCOPED]);
    const result = await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD), requestFor(SCOPED)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });

    expect(result.ok).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(destDir, "index.json"), "utf8")) as Record<
      string,
      { versions: Record<string, { dist: { tarball: string } }> }
    >;
    // The lockfile's own URL never appears: the builder reads only what the orchestrator staged.
    expect(index["@types/node"].versions["20.11.0"].dist.tarball).toBe(
      "http://127.0.0.1:4873/@types/node/-/node-20.11.0.tgz",
    );
    const routes = JSON.parse(fs.readFileSync(path.join(destDir, "tarballs.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(routes["/@types/node/-/node-20.11.0.tgz"]).toBe(tarballFileName(SCOPED.name, SCOPED.version));
    expect(
      fs.readFileSync(path.join(destDir, "tarballs", routes["/left-pad/-/left-pad-1.3.0.tgz"])),
    ).toEqual(bytesFor("left-pad@1.3.0"));
  });

  it("resolves against the orchestrator's registry, never a host the caller supplies", async () => {
    const reg = fakeRegistry([LEFT_PAD]);
    await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });
    expect(reg.urls.every((u) => u.startsWith(REGISTRY))).toBe(true);
  });

  it("refuses a lockfile digest the registry never published — the H1 shape", async () => {
    const reg = fakeRegistry([LEFT_PAD]);
    reg.publishedIntegrity.set("left-pad@1.3.0", sha512Integrity(Buffer.from("real bytes")));
    const result = await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failedPackage: "left-pad@1.3.0" });
    expect(fs.existsSync(path.join(destDir, "index.json"))).toBe(false);
  });

  it("refuses bytes that do not hash to the digest both sides agreed on", async () => {
    const reg = fakeRegistry([LEFT_PAD]);
    reg.servedBytes.set("left-pad@1.3.0", Buffer.from("swapped bytes"));
    const result = await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failedPackage: "left-pad@1.3.0" });
    expect(result.ok ? "" : result.detail).toContain("not the pinned");
  });

  it("names the first failing package and stops, rather than reporting the last", async () => {
    const reg = fakeRegistry([LEFT_PAD, SCOPED]);
    reg.missingVersions.add("left-pad@1.3.0");
    const result = await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD), requestFor(SCOPED)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failedPackage: "left-pad@1.3.0" });
    expect(reg.urls.some((u) => u.includes("%2fnode"))).toBe(false);
  });

  it("refuses a tarball past the per-package cap before buffering the whole body", async () => {
    const reg = fakeRegistry([LEFT_PAD]);
    const result = await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
      maxTarballBytes: 4,
    });
    expect(result).toMatchObject({ ok: false, failedPackage: "left-pad@1.3.0" });
    expect(result.ok ? "" : result.detail).toContain("per-package cap");
  });

  it.each([
    ["../../etc/passwd", "1.0.0"],
    ["left-pad", "../1.0.0"],
    ["@scope/../x", "1.0.0"],
  ])("refuses %s@%s, which the registry could not have published", async (name, version) => {
    const reg = fakeRegistry([]);
    const result = await stageVerifiedRegistry({
      packages: [{ key: `${name}@${version}`, name, version, integrity: "sha512-x" }],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(reg.urls).toEqual([]);
  });

  it("stops when the staged set passes its byte cap", async () => {
    const reg = fakeRegistry([LEFT_PAD]);
    const result = await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD)],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
      maxTotalBytes: 4,
    });
    expect(result).toMatchObject({ ok: false, failedPackage: "left-pad@1.3.0" });
  });

  it("fetches each package's packument once however many versions it pins", async () => {
    const reg = fakeRegistry([LEFT_PAD, { name: "left-pad", version: "1.2.0" }]);
    await stageVerifiedRegistry({
      packages: [requestFor(LEFT_PAD), requestFor({ name: "left-pad", version: "1.2.0" })],
      destDir,
      registryUrl: REGISTRY,
      builderRegistryUrl: BUILDER,
      fetchImpl: reg.fetchImpl,
    });
    expect(reg.urls.filter((u) => u.endsWith("/left-pad"))).toHaveLength(1);
  });
});

describe("sha512Integrity", () => {
  it("produces the `sha512-<base64>` form a pnpm lockfile records", () => {
    // Fixed vector: the digest of the empty string, which is what a lockfile entry compares to.
    expect(sha512Integrity(Buffer.alloc(0))).toBe(
      "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    );
  });
});
