/**
 * Tests for Node runtime provisioning (docs/248, nikzlabs/shipit#1728).
 *
 * The network and tar are injected, so these cover the decision table — which
 * outcome each repo/pin combination produces, and what lands on PATH — without
 * downloading 50 MB of Node.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_ACTIVATABLE_MAJOR,
  PATH_HANDOFF_FILE,
  distArch,
  findComposeNodeConflicts,
  formatNodeRuntimeNotice,
  installDirName,
  isMountPoint,
  listCachedVersions,
  prefixPromptWithNotice,
  provisionNodeRuntime,
  resetNodeRuntimeForTests,
  resolveNodeCacheDir,
  type ProvisionDeps,
} from "./node-runtime.js";
import { parseVersion, type NodeVersion } from "../shared/node-pin.js";

const ARCH = distArch() ?? "x64";

function v(text: string): NodeVersion {
  const parsed = parseVersion(text);
  if (!parsed) throw new Error(`bad test version ${text}`);
  return parsed;
}

/** A fake toolchain on disk: enough for `listCachedVersions` to accept it. */
function seedCached(cacheDir: string, version: string): string {
  const dir = path.join(cacheDir, installDirName(v(version), ARCH));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "node"), "#!/bin/sh\n");
  return dir;
}

describe("node-runtime provisioning", () => {
  let workspace: string;
  let cacheDir: string;
  let originalPath: string | undefined;

  /** Records what the fake installer was asked for. */
  let installed: string[];

  function deps(overrides: Partial<ProvisionDeps> = {}): Partial<ProvisionDeps> {
    return {
      currentVersion: () => "v24.15.0",
      listRemoteVersions: async () => [v("18.20.4"), v("20.19.0"), v("22.9.0"), v("22.20.1"), v("24.15.0")],
      install: async (version, dir) => {
        installed.push(`${version.major}.${version.minor}.${version.patch}`);
        return seedCached(dir, `${version.major}.${version.minor}.${version.patch}`);
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-ws-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-cache-"));
    originalPath = process.env.PATH;
    installed = [];
    resetNodeRuntimeForTests();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.SHIPIT_PINNED_NODE;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("does nothing at all when the repo pins nothing", async () => {
    const status = await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });
    expect(status.state).toBe("no-pin");
    expect(status.mismatch).toBe(false);
    expect(status.composeNodeConflicts).toEqual([]);
    expect(installed).toEqual([]);
    expect(process.env.SHIPIT_PINNED_NODE).toBeUndefined();
  });

  it("provisions the pinned major and puts it first on PATH — the reported bug", async () => {
    // The exact repro from nikzlabs/shipit#1728: `.nvmrc` says 22, container is 24.
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22\n");

    const status = await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });

    expect(status.state).toBe("provisioned");
    expect(status.pinSource).toBe(".nvmrc");
    expect(status.pinRaw).toBe("22");
    // Newest release in the pinned line, not merely the first match.
    expect(status.resolvedVersion).toBe("22.20.1");
    expect(status.activeVersion).toBe("22.20.1");
    expect(status.imageVersion).toBe("24.15.0");
    expect(status.mismatch).toBe(false);
    expect(installed).toEqual(["22.20.1"]);

    const binDir = path.join(cacheDir, installDirName(v("22.20.1"), ARCH), "bin");
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe(binDir);
  });

  it("exports the resolved version so the install marker keys on the right ABI", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22");
    await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });
    expect(process.env.SHIPIT_PINNED_NODE).toBe("22.20.1");
  });

  it("leaves the runtime alone when the container's Node already satisfies the pin", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ engines: { node: ">=20" } }),
    );

    const status = await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });

    expect(status.state).toBe("satisfied");
    expect(status.activeVersion).toBe("24.15.0");
    expect(status.mismatch).toBe(false);
    expect(installed).toEqual([]);
    // No PATH churn and no key change for the overwhelmingly common range pin.
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.SHIPIT_PINNED_NODE).toBeUndefined();
  });

  it("reuses a cached toolchain without touching the network", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22");
    seedCached(cacheDir, "22.20.1");

    const status = await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      deps: deps({
        listRemoteVersions: async () => {
          throw new Error("must not hit the network on a warm cache");
        },
      }),
    });

    expect(status.state).toBe("provisioned");
    expect(status.resolvedVersion).toBe("22.20.1");
  });

  it("reports an unsupported pin instead of guessing at it", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "lts/jod");

    const status = await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });

    expect(status.state).toBe("unsupported");
    expect(status.mismatch).toBe(true);
    expect(status.reason).toContain("lts/jod");
    expect(installed).toEqual([]);
  });

  it("refuses to activate a pin below the floor, and says why", async () => {
    // Honoring this would leave the session with no working agent CLI, so the
    // pin falls back to the reporting path (requirement 6) instead.
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "18");

    const status = await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });

    expect(status.state).toBe("below-floor");
    expect(status.resolvedVersion).toBe("18.20.4");
    expect(status.activeVersion).toBe("24.15.0");
    expect(status.mismatch).toBe(true);
    expect(status.reason).toContain(String(MIN_ACTIVATABLE_MAJOR));
    expect(installed).toEqual([]);
  });

  it("reports a failed download instead of throwing", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22");

    const status = await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      deps: deps({
        install: async () => {
          throw new Error("checksum mismatch for node-v22.20.1-linux-x64.tar.gz");
        },
      }),
    });

    expect(status.state).toBe("failed");
    expect(status.mismatch).toBe(true);
    expect(status.reason).toContain("checksum mismatch");
    // The session keeps running on the image's Node rather than failing to start.
    expect(status.activeVersion).toBe("24.15.0");
  });

  it("reports a failure when nodejs.org can't be reached and the cache is cold", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22");

    const status = await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      deps: deps({
        listRemoteVersions: async () => {
          throw new Error("getaddrinfo EAI_AGAIN nodejs.org");
        },
      }),
    });

    expect(status.state).toBe("failed");
    expect(status.reason).toContain("nodejs.org");
  });

  it("reports a pin no released version satisfies", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "99");

    const status = await provisionNodeRuntime({ workspaceDir: workspace, cacheDir, deps: deps() });

    expect(status.state).toBe("failed");
    expect(status.reason).toContain("no released Node version");
  });
});

// docs/248 review finding 1 — Codex runs every tool command as `bash -lc`, and
// Debian's /etc/profile overwrites PATH. The profile.d snippet reads this file,
// so publishing it correctly is what makes the pin reach those commands.
describe("login-shell PATH handoff", () => {
  let workspace: string;
  let cacheDir: string;
  let stateDir: string;
  let originalPath: string | undefined;

  const fakeInstall = async (version: { major: number; minor: number; patch: number }, dir: string) =>
    seedCached(dir, `${version.major}.${version.minor}.${version.patch}`);

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-hw-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-hc-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-hs-"));
    originalPath = process.env.PATH;
    resetNodeRuntimeForTests();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.SHIPIT_PINNED_NODE;
    for (const d of [workspace, cacheDir, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("publishes the pinned bin dir for login shells", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22");
    await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      stateDir,
      deps: {
        currentVersion: () => "v24.15.0",
        listRemoteVersions: async () => [v("22.20.1")],
        install: fakeInstall,
      },
    });
    const published = fs.readFileSync(path.join(stateDir, PATH_HANDOFF_FILE), "utf-8");
    expect(published).toBe(path.join(cacheDir, installDirName(v("22.20.1"), ARCH), "bin"));
  });

  it("retracts a stale handoff when the repo no longer pins anything", async () => {
    // A previous container pinned 22; the repo has since dropped its .nvmrc.
    // Leaving the file would keep login shells on a Node we aren't using.
    fs.writeFileSync(path.join(stateDir, PATH_HANDOFF_FILE), "/stale/bin");
    const status = await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      stateDir,
      deps: { currentVersion: () => "v24.15.0" },
    });
    expect(status.state).toBe("no-pin");
    expect(fs.existsSync(path.join(stateDir, PATH_HANDOFF_FILE))).toBe(false);
  });

  it("retracts the handoff when the pin can't be honored", async () => {
    fs.writeFileSync(path.join(stateDir, PATH_HANDOFF_FILE), "/stale/bin");
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "18");
    const status = await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      stateDir,
      deps: {
        currentVersion: () => "v24.15.0",
        listRemoteVersions: async () => [v("18.20.4")],
        install: fakeInstall,
      },
    });
    expect(status.state).toBe("below-floor");
    expect(fs.existsSync(path.join(stateDir, PATH_HANDOFF_FILE))).toBe(false);
  });
});

// docs/248 requirement 5 — reported, never resolved: a Compose image is
// deliberately not a pin source, so the disagreement has to be visible.
describe("findComposeNodeConflicts", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-compose-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function writeCompose(body: string): void {
    fs.writeFileSync(path.join(workspace, "docker-compose.yml"), body);
  }

  it("reports a service pinned to a different Node major", () => {
    writeCompose("services:\n  web:\n    image: node:22\n");
    expect(findComposeNodeConflicts(workspace, 24)).toEqual([
      { service: "web", image: "node:22", major: 22 },
    ]);
  });

  it("says nothing when the majors agree", () => {
    writeCompose("services:\n  web:\n    image: node:22-alpine\n");
    expect(findComposeNodeConflicts(workspace, 22)).toEqual([]);
  });

  it("handles tag suffixes and registry prefixes", () => {
    writeCompose(
      "services:\n  a:\n    image: node:20-bookworm-slim\n  b:\n    image: docker.io/library/node:18.20.4\n",
    );
    expect(findComposeNodeConflicts(workspace, 24).map((c) => c.major).sort()).toEqual([18, 20]);
  });

  it("ignores services that pin no Node major", () => {
    writeCompose(
      "services:\n  db:\n    image: postgres:16\n  app:\n    image: node:latest\n  built:\n    build: .\n",
    );
    expect(findComposeNodeConflicts(workspace, 24)).toEqual([]);
  });

  it("is silent when there is no compose file or it is unparseable", () => {
    expect(findComposeNodeConflicts(workspace, 24)).toEqual([]);
    writeCompose("services: [this is not: a map\n");
    expect(findComposeNodeConflicts(workspace, 24)).toEqual([]);
  });
});

// docs/248-repo-node-version req 8 — the agent shouldn't have to ask. Before this, an un-honored
// pin lived only in the diagnostics panel, which the agent cannot reach.
describe("formatNodeRuntimeNotice", () => {
  const base = {
    pinSource: null,
    pinRaw: null,
    resolvedVersion: null,
    activeVersion: "24.15.0",
    imageVersion: "24.15.0",
    reason: null,
    mismatch: false,
    composeNodeConflicts: [],
  };

  it("says nothing for the sessions that are fine — which is almost all of them", () => {
    expect(formatNodeRuntimeNotice({ ...base, state: "no-pin" })).toBeNull();
    expect(formatNodeRuntimeNotice({ ...base, state: "satisfied" })).toBeNull();
    expect(
      formatNodeRuntimeNotice({
        ...base,
        state: "provisioned",
        activeVersion: "22.20.1",
        resolvedVersion: "22.20.1",
        pinRaw: "22",
        pinSource: ".nvmrc",
      }),
    ).toBeNull();
  });

  it("fires on every un-honored state, not just a failed download", () => {
    // `unsupported` and `below-floor` are the same thing from the agent's point
    // of view: the repo asked for a Node it isn't getting.
    for (const state of ["failed", "unsupported", "below-floor"] as const) {
      const notice = formatNodeRuntimeNotice({
        ...base,
        state,
        mismatch: true,
        pinRaw: "22",
        pinSource: ".nvmrc",
      });
      expect(notice, state).not.toBeNull();
    }
  });

  it("carries what the agent needs to act on", () => {
    const notice = formatNodeRuntimeNotice({
      ...base,
      state: "failed",
      mismatch: true,
      pinSource: ".nvmrc",
      pinRaw: "22",
      resolvedVersion: "22.20.1",
      reason: "getaddrinfo EAI_AGAIN nodejs.org",
    })!;
    expect(notice.startsWith("<system>")).toBe(true);
    expect(notice.trimEnd().endsWith("</system>")).toBe(true);
    expect(notice).toContain("24.15.0");
    expect(notice).toContain("22 (.nvmrc)");
    expect(notice).toContain("22.20.1");
    expect(notice).toContain("EAI_AGAIN");
  });

  it("omits the rows it has no value for", () => {
    const notice = formatNodeRuntimeNotice({ ...base, state: "failed", mismatch: true })!;
    expect(notice).not.toContain("repo pin:");
    expect(notice).not.toContain("wanted:");
    expect(notice).not.toContain("reason:");
  });
});

describe("prefixPromptWithNotice", () => {
  const notice = "<system>\nheads up\n</system>";

  it("leads with the notice so the agent reads it before the request", () => {
    expect(prefixPromptWithNotice("fix the build", notice)).toBe(`${notice}\n\nfix the build`);
  });

  it("keeps a slash command at position 0 or the CLI stops parsing it", () => {
    expect(prefixPromptWithNotice("/compact", notice)).toBe(`/compact\n\n${notice}`);
    expect(prefixPromptWithNotice("  /code-review now", notice))
      .toBe(`  /code-review now\n\n${notice}`);
  });

  it("does not mistake a path or division for a slash command", () => {
    expect(prefixPromptWithNotice("/ is the root", notice).startsWith(notice)).toBe(true);
  });
});

describe("listCachedVersions", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-rt-list-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns nothing for a missing cache dir", () => {
    expect(listCachedVersions(path.join(cacheDir, "nope"), ARCH)).toEqual([]);
  });

  it("skips a half-extracted tree left by a crash", () => {
    // Directory present, `bin/node` absent — PATH-prepending it would give the
    // session a `node` that doesn't exist.
    fs.mkdirSync(path.join(cacheDir, installDirName(v("22.20.1"), ARCH)), { recursive: true });
    expect(listCachedVersions(cacheDir, ARCH)).toEqual([]);
  });

  it("ignores unrelated entries and other architectures", () => {
    fs.mkdirSync(path.join(cacheDir, "npm"), { recursive: true });
    fs.mkdirSync(path.join(cacheDir, "node-v22.20.1-linux-sparc", "bin"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "node-v22.20.1-linux-sparc", "bin", "node"), "");
    expect(listCachedVersions(cacheDir, ARCH)).toEqual([]);
  });

  it("finds a complete toolchain", () => {
    const dir = path.join(cacheDir, installDirName(v("22.20.1"), ARCH), "bin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node"), "");
    expect(listCachedVersions(cacheDir, ARCH)).toEqual([v("22.20.1")]);
  });
});

describe("resolveNodeCacheDir", () => {
  it("prefers the shared dep cache when it is a real mount", () => {
    expect(resolveNodeCacheDir("/dep-cache", "/session-state", () => true)).toBe(
      "/dep-cache/node-versions",
    );
  });

  it("falls back to the state dir when the mount is absent", () => {
    expect(resolveNodeCacheDir("/dep-cache", "/session-state", () => false)).toBe(
      path.join("/session-state", "node-versions"),
    );
  });

  it("does not treat a plain directory as the shared cache", () => {
    // The container entrypoint `mkdir -p`s /dep-cache unconditionally, so mere
    // existence would park ~200 MB on the container's writable layer, shared
    // with nobody and discarded on the next container.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "dep-cache-"));
    try {
      expect(isMountPoint(plain)).toBe(false);
      expect(resolveNodeCacheDir(plain, "/session-state")).toBe("/session-state/node-versions");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
