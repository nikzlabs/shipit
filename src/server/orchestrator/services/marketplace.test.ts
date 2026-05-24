/**
 * Marketplace service tests (docs/149).
 *
 * Builds a fake catalog clone on disk and exercises the listPlugins /
 * installPlugin / uninstallPlugin / scanInstalledPlugins flow against it.
 * No network calls — `ensureCatalogCloned` is bypassed by pre-populating the
 * cache dir. The git operations run against a real `simpleGit` repo in a
 * temp dir so `commitPaths` is verified end-to-end too.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { MarketplaceStore } from "../marketplace-store.js";
import {
  installPlugin,
  listPlugins,
  uninstallPlugin,
  scanInstalledPlugins,
  withWorkspaceLock,
  rewriteFrontmatterName,
  INSTALL_MARKER_FILENAME,
} from "./marketplace.js";
import { ServiceError } from "./types.js";

const PLUGIN_NAME = "commit-commands";
const SKILL_NAME_A = "commit";
const SKILL_NAME_B = "push";

function makeFakeCatalog(cacheRoot: string, id: string): string {
  const cacheDir = path.join(cacheRoot, id);
  fs.mkdirSync(path.join(cacheDir, ".claude-plugin"), { recursive: true });
  const manifest = {
    name: id,
    plugins: [
      {
        name: PLUGIN_NAME,
        description: "Two skills for committing and pushing",
        source: `./plugins/${PLUGIN_NAME}`,
        author: { name: "Anthropic" },
      },
      // External plugin — must be filtered out by listPlugins in v1.
      {
        name: "external-thing",
        description: "External plugin (git source)",
        source: { source: "url", url: "https://example.com/x.git", sha: "abc" },
      },
      // No-skills plugin — also filtered.
      {
        name: "commands-only",
        description: "Only commands, no skills",
        source: "./plugins/commands-only",
      },
    ],
  };
  fs.writeFileSync(
    path.join(cacheDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(manifest, null, 2),
  );

  // Plugin with two skills
  const pluginRoot = path.join(cacheDir, "plugins", PLUGIN_NAME);
  fs.mkdirSync(path.join(pluginRoot, "skills", SKILL_NAME_A), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "skills", SKILL_NAME_A, "SKILL.md"),
    "---\nname: commit\ndescription: stage and commit\n---\n\nStage and commit\n",
  );
  fs.mkdirSync(path.join(pluginRoot, "skills", SKILL_NAME_B), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "skills", SKILL_NAME_B, "SKILL.md"),
    "---\nname: push\ndescription: push to remote\n---\n\nPush\n",
  );

  // Commands-only plugin (no skills dir on purpose)
  fs.mkdirSync(path.join(cacheDir, "plugins", "commands-only", "commands"), { recursive: true });

  return cacheDir;
}

async function initRepo(workspace: string): Promise<GitManager> {
  fs.mkdirSync(workspace, { recursive: true });
  // Need an initial commit so commitPaths has a base. We also configure
  // identity locally so this test doesn't depend on global git config.
  const sg = simpleGit(workspace);
  await sg.init(["--initial-branch=main"]);
  await sg.addConfig("user.name", "Test", undefined, "local");
  await sg.addConfig("user.email", "test@example.com", undefined, "local");
  fs.writeFileSync(path.join(workspace, "README.md"), "hi\n");
  await sg.add(["README.md"]);
  await sg.commit("init");
  return new GitManager(workspace);
}

describe("services/marketplace (docs/149)", () => {
  let tmp: string;
  let dbm: DatabaseManager;
  let store: MarketplaceStore;
  let cacheRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-svc-"));
    dbm = new DatabaseManager(path.join(tmp, "test.db"));
    store = new MarketplaceStore(dbm);
    store.seedIfMissing({
      id: "test-catalog",
      source: { kind: "github", ownerRepo: "test/test" },
      agentId: "claude",
      autoUpdate: true,
    });
    cacheRoot = path.join(tmp, "marketplace-cache");
    makeFakeCatalog(cacheRoot, "test-catalog");
  });

  afterEach(() => {
    dbm.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("listPlugins", () => {
    it("returns only in-repo plugins that have at least one skill", async () => {
      const plugins = await listPlugins(store, "test-catalog", cacheRoot);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe(PLUGIN_NAME);
      expect(plugins[0].skills.map((s) => s.name).sort()).toEqual([SKILL_NAME_A, SKILL_NAME_B]);
      expect(plugins[0].author).toBe("Anthropic");
      expect(plugins[0].estimatedContextBytes).toBeGreaterThan(0);
    });

    it("rejects unknown marketplaces", async () => {
      await expect(listPlugins(store, "nope", cacheRoot)).rejects.toThrow(ServiceError);
    });
  });

  describe("installPlugin", () => {
    it("writes flat <plugin>__<skill>/ dirs with rewritten frontmatter and a marker, and commits path-scoped", async () => {
      const workspace = path.join(tmp, "ws");
      const git = await initRepo(workspace);
      // Write an unrelated dirty file BEFORE install — the path-scoped commit
      // must NOT include it (this is the whole point of `commitPaths`).
      fs.writeFileSync(path.join(workspace, "scratch.txt"), "user edit\n");

      const result = await withWorkspaceLock(workspace, async () =>
        installPlugin({
          workspaceDir: workspace,
          agentId: "claude",
          marketplaceId: "test-catalog",
          pluginName: PLUGIN_NAME,
          cacheRoot,
          store,
          git,
        }),
      );

      expect(result.installedDirs).toHaveLength(2);
      expect(result.invocationTokens.sort()).toEqual([
        `/${PLUGIN_NAME}:${SKILL_NAME_A}`,
        `/${PLUGIN_NAME}:${SKILL_NAME_B}`,
      ]);
      expect(result.commitHash).toBeTruthy();

      // Files landed at the expected flat-dir paths.
      const dirA = path.join(workspace, ".claude", "skills", `${PLUGIN_NAME}__${SKILL_NAME_A}`);
      expect(fs.existsSync(path.join(dirA, "SKILL.md"))).toBe(true);
      const skillBody = fs.readFileSync(path.join(dirA, "SKILL.md"), "utf-8");
      expect(skillBody).toMatch(/^name: commit-commands:commit$/m);

      // Marker is present and well-formed.
      const marker = JSON.parse(
        fs.readFileSync(path.join(dirA, INSTALL_MARKER_FILENAME), "utf-8"),
      ) as { marketplaceId: string; pluginName: string; skillMdHash: string };
      expect(marker.marketplaceId).toBe("test-catalog");
      expect(marker.pluginName).toBe(PLUGIN_NAME);
      expect(marker.skillMdHash).toMatch(/^[0-9a-f]{64}$/);

      // The unrelated scratch.txt is still uncommitted (no `git add -A`).
      const status = await simpleGit(workspace).status();
      expect(status.not_added).toContain("scratch.txt");
    });

    it("refuses install when the directory already exists with no marker (hand-written collision)", async () => {
      const workspace = path.join(tmp, "ws2");
      const git = await initRepo(workspace);
      const handDir = path.join(workspace, ".claude", "skills", `${PLUGIN_NAME}__${SKILL_NAME_A}`);
      fs.mkdirSync(handDir, { recursive: true });
      fs.writeFileSync(path.join(handDir, "SKILL.md"), "---\nname: hand\n---\nmine\n");

      await expect(
        withWorkspaceLock(workspace, async () =>
          installPlugin({
            workspaceDir: workspace,
            agentId: "claude",
            marketplaceId: "test-catalog",
            pluginName: PLUGIN_NAME,
            cacheRoot,
            store,
            git,
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      // Hand-written file untouched.
      expect(fs.readFileSync(path.join(handDir, "SKILL.md"), "utf-8")).toMatch(/mine/);
    });

    it("refuses install when the directory already has a marker (already installed)", async () => {
      const workspace = path.join(tmp, "ws3");
      const git = await initRepo(workspace);
      await withWorkspaceLock(workspace, async () =>
        installPlugin({
          workspaceDir: workspace,
          agentId: "claude",
          marketplaceId: "test-catalog",
          pluginName: PLUGIN_NAME,
          cacheRoot,
          store,
          git,
        }),
      );
      await expect(
        withWorkspaceLock(workspace, async () =>
          installPlugin({
            workspaceDir: workspace,
            agentId: "claude",
            marketplaceId: "test-catalog",
            pluginName: PLUGIN_NAME,
            cacheRoot,
            store,
            git,
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("refuses Codex installs in v1 (Codex is v1b)", async () => {
      const workspace = path.join(tmp, "ws-codex");
      const git = await initRepo(workspace);
      await expect(
        installPlugin({
          workspaceDir: workspace,
          agentId: "codex",
          marketplaceId: "test-catalog",
          pluginName: PLUGIN_NAME,
          cacheRoot,
          store,
          git,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("scanInstalledPlugins + uninstallPlugin", () => {
    it("scans only directories with a valid marker, and uninstall removes them", async () => {
      const workspace = path.join(tmp, "ws4");
      const git = await initRepo(workspace);
      await withWorkspaceLock(workspace, async () =>
        installPlugin({
          workspaceDir: workspace,
          agentId: "claude",
          marketplaceId: "test-catalog",
          pluginName: PLUGIN_NAME,
          cacheRoot,
          store,
          git,
        }),
      );
      // Add a hand-written sibling dir; scan must ignore it.
      const handDir = path.join(workspace, ".claude", "skills", "hand-written");
      fs.mkdirSync(handDir, { recursive: true });
      fs.writeFileSync(path.join(handDir, "SKILL.md"), "---\nname: hand\n---\nmine\n");

      const installed = await scanInstalledPlugins(workspace, "claude");
      expect(installed).toHaveLength(2);
      expect(installed.every((e) => e.marketplaceId === "test-catalog")).toBe(true);
      expect(installed.every((e) => e.pluginName === PLUGIN_NAME)).toBe(true);

      const removed = await withWorkspaceLock(workspace, async () =>
        uninstallPlugin({
          workspaceDir: workspace,
          agentId: "claude",
          marketplaceId: "test-catalog",
          pluginName: PLUGIN_NAME,
          git,
        }),
      );
      expect(removed.removed).toHaveLength(2);
      // Hand-written sibling survived.
      expect(fs.existsSync(path.join(handDir, "SKILL.md"))).toBe(true);
      // Managed dirs gone.
      expect(
        fs.existsSync(path.join(workspace, ".claude", "skills", `${PLUGIN_NAME}__${SKILL_NAME_A}`)),
      ).toBe(false);
    });

    it("uninstall is a 404 when nothing is installed", async () => {
      const workspace = path.join(tmp, "ws5");
      const git = await initRepo(workspace);
      await expect(
        uninstallPlugin({
          workspaceDir: workspace,
          agentId: "claude",
          marketplaceId: "test-catalog",
          pluginName: PLUGIN_NAME,
          git,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("withWorkspaceLock", () => {
    it("serializes concurrent installs on the same workspace", async () => {
      const workspace = path.join(tmp, "ws-mutex");
      const git = await initRepo(workspace);
      const order: string[] = [];
      const slowOp = async (label: string): Promise<void> => {
        order.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${label}-end`);
      };
      await Promise.all([
        withWorkspaceLock(workspace, () => slowOp("a")),
        withWorkspaceLock(workspace, () => slowOp("b")),
      ]);
      expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
      // Make sure `git` ref doesn't trip an unused-var lint in the test.
      void git;
    });
  });

  describe("rewriteFrontmatterName", () => {
    it("replaces an existing name field in place", () => {
      const out = rewriteFrontmatterName(
        "---\nname: foo\ndescription: bar\n---\nbody\n",
        "ns:foo",
      );
      expect(out).toMatch(/^---\nname: ns:foo\ndescription: bar\n---\nbody\n/);
    });

    it("inserts a name field when none is present", () => {
      const out = rewriteFrontmatterName("---\ndescription: bar\n---\nbody\n", "ns:foo");
      expect(out).toMatch(/^---\nname: ns:foo\ndescription: bar\n---/);
    });

    it("synthesizes a frontmatter block when the file has none", () => {
      const out = rewriteFrontmatterName("just body\n", "ns:foo");
      expect(out.startsWith("---\nname: ns:foo\n---\n")).toBe(true);
    });
  });
});
