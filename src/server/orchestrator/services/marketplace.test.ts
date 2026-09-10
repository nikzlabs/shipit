import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { MarketplaceStore } from "../marketplace-store.js";
import {
  ensureCatalogCloned,
  installPlugin,
  listPlugins,
  withWorkspaceLock,
  rewriteFrontmatterName,
  readPluginSkillBody,
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
      {
        name: "external-thing",
        description: "External plugin (git source)",
        source: { source: "url", url: "https://example.com/x.git", sha: "abc" },
      },
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

  fs.mkdirSync(path.join(cacheDir, "plugins", "commands-only", "commands"), { recursive: true });

  return cacheDir;
}

function makeFakeCodexCatalog(cacheRoot: string, id: string): string {
  const cacheDir = path.join(cacheRoot, id);
  fs.mkdirSync(path.join(cacheDir, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: id,
      plugins: [
        {
          name: "codex-tools",
          source: { source: "local", path: "./plugins/codex-tools" },
          category: "Developer Tools",
        },
      ],
    }),
  );

  const pluginRoot = path.join(cacheDir, "plugins", "codex-tools");
  fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "codex-tools",
      description: "Codex workflows",
      author: { name: "OpenAI" },
      skills: "./skills/",
    }),
  );
  const skillDir = path.join(pluginRoot, "skills", "review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: review\ndescription: review code\n---\n\nReview code\n",
  );

  return cacheDir;
}

// Use file:// transport to exercise shallow cloning; a bare path ignores --depth.
async function makeOriginRepo(dir: string, marker: string): Promise<void> {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  const sg = simpleGit(dir);
  await sg.init(["--initial-branch=main"]);
  await sg.addConfig("user.name", "Test", undefined, "local");
  await sg.addConfig("user.email", "test@example.com", undefined, "local");
  await writeOriginCatalog(dir, marker);
  await sg.add(["-A"]);
  await sg.commit("catalog");
}

async function writeOriginCatalog(dir: string, marker: string): Promise<void> {
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "origin-catalog",
      plugins: [{ name: marker, description: marker, source: `./plugins/${marker}` }],
    }),
  );
  const skillDir = path.join(dir, "plugins", marker, "skills", "only");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: only\ndescription: ${marker}\n---\n\n${marker}\n`,
  );
}

async function commitOriginCatalog(dir: string, marker: string): Promise<void> {
  await writeOriginCatalog(dir, marker);
  const sg = simpleGit(dir);
  await sg.add(["-A"]);
  await sg.commit(`catalog ${marker}`);
}

async function initRepo(workspace: string): Promise<GitManager> {
  fs.mkdirSync(workspace, { recursive: true });
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
  let agentRegistry: AgentRegistry;

  beforeEach(async () => {
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
    makeFakeCodexCatalog(cacheRoot, "codex-catalog");
    store.seedIfMissing({
      id: "codex-catalog",
      source: { kind: "github", ownerRepo: "openai/plugins" },
      agentId: "codex",
      autoUpdate: true,
    });
    agentRegistry = new AgentRegistry({ checkBinary: () => Promise.resolve(true) });
    await agentRegistry.detect();
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

    it("reads Codex .agents/plugins marketplace files with local source.path entries", async () => {
      const plugins = await listPlugins(store, "codex-catalog", cacheRoot);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        marketplaceId: "codex-catalog",
        name: "codex-tools",
        description: "Codex workflows",
        author: "OpenAI",
        category: "Developer Tools",
      });
      expect(plugins[0].skills.map((s) => s.name)).toEqual(["review"]);
    });
  });

  describe("installPlugin", () => {
    it("writes flat <plugin>__<skill>/ dirs with rewritten frontmatter and a marker, and commits path-scoped", async () => {
      const workspace = path.join(tmp, "ws");
      const git = await initRepo(workspace);
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
          agentRegistry,
        }),
      );

      expect(result.installedDirs).toHaveLength(2);
      expect(result.invocationTokens.sort()).toEqual([
        `/${PLUGIN_NAME}:${SKILL_NAME_A}`,
        `/${PLUGIN_NAME}:${SKILL_NAME_B}`,
      ]);
      expect(result.commitHash).toBeTruthy();

      const dirA = path.join(workspace, ".claude", "skills", `${PLUGIN_NAME}__${SKILL_NAME_A}`);
      expect(fs.existsSync(path.join(dirA, "SKILL.md"))).toBe(true);
      const skillBody = fs.readFileSync(path.join(dirA, "SKILL.md"), "utf-8");
      expect(skillBody).toMatch(/^name: commit-commands:commit$/m);

      const marker = JSON.parse(
        fs.readFileSync(path.join(dirA, INSTALL_MARKER_FILENAME), "utf-8"),
      ) as { marketplaceId: string; pluginName: string; skillMdHash: string };
      expect(marker.marketplaceId).toBe("test-catalog");
      expect(marker.pluginName).toBe(PLUGIN_NAME);
      expect(marker.skillMdHash).toMatch(/^[0-9a-f]{64}$/);

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
            agentRegistry,
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
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
          agentRegistry,
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
            agentRegistry,
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("handles plugins where the skill's source directory name differs from its frontmatter name (e.g. hookify)", async () => {
      const cacheDir = path.join(cacheRoot, "mismatch-catalog");
      fs.mkdirSync(path.join(cacheDir, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "mismatch-catalog",
          plugins: [{ name: "hookify", source: "./plugins/hookify" }],
        }),
      );
      const srcSkillDir = path.join(cacheDir, "plugins", "hookify", "skills", "writing-rules");
      fs.mkdirSync(srcSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcSkillDir, "SKILL.md"),
        "---\nname: writing-hookify-rules\ndescription: rule writer\n---\n\nbody\n",
      );
      store.seedIfMissing({
        id: "mismatch-catalog",
        source: { kind: "github", ownerRepo: "test/mismatch" },
        agentId: "claude",
        autoUpdate: true,
      });

      const plugins = await listPlugins(store, "mismatch-catalog", cacheRoot);
      expect(plugins[0].skills[0].name).toBe("writing-hookify-rules");
      expect(plugins[0].skills[0].dirName).toBe("writing-rules");

      const body = await readPluginSkillBody(
        store,
        "mismatch-catalog",
        cacheRoot,
        "hookify",
        "writing-hookify-rules",
      );
      expect(body).toContain("name: writing-hookify-rules");

      const workspace = path.join(tmp, "ws-mismatch");
      const git = await initRepo(workspace);
      const result = await withWorkspaceLock(workspace, async () =>
        installPlugin({
          workspaceDir: workspace,
          agentId: "claude",
          marketplaceId: "mismatch-catalog",
          pluginName: "hookify",
          cacheRoot,
          store,
          git,
          agentRegistry,
        }),
      );
      expect(result.invocationTokens).toEqual(["/hookify:writing-hookify-rules"]);
      const installed = path.join(
        workspace, ".claude", "skills", "hookify__writing-hookify-rules", "SKILL.md",
      );
      expect(fs.existsSync(installed)).toBe(true);
      expect(fs.readFileSync(installed, "utf-8")).toMatch(/^name: hookify:writing-hookify-rules$/m);
    });

    it("installs Codex skills into .codex/skills and returns $ invocation tokens", async () => {
      const workspace = path.join(tmp, "ws-codex");
      const git = await initRepo(workspace);
      const result = await withWorkspaceLock(workspace, async () =>
        installPlugin({
          workspaceDir: workspace,
          agentId: "codex",
          marketplaceId: "codex-catalog",
          pluginName: "codex-tools",
          cacheRoot,
          store,
          git,
          agentRegistry,
        }),
      );

      expect(result.invocationTokens).toEqual(["$codex-tools:review"]);
      const skillMd = path.join(workspace, ".codex", "skills", "codex-tools__review", "SKILL.md");
      expect(fs.existsSync(skillMd)).toBe(true);
      expect(fs.readFileSync(skillMd, "utf-8")).toMatch(/^name: codex-tools:review$/m);
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
      void git;
    });
  });

  describe("ensureCatalogCloned recovery", () => {
    let originDir: string;
    let liveRoot: string;

    function seedLiveCatalog(id: string): void {
      store.seedIfMissing({
        id,
        source: { kind: "git", url: `file://${originDir}` },
        agentId: "claude",
        autoUpdate: true,
      });
    }

    beforeEach(async () => {
      originDir = path.join(tmp, "origin");
      liveRoot = path.join(tmp, "live-cache");
      await makeOriginRepo(originDir, "first");
    });

    it("clones on first use and marks the row ok", async () => {
      seedLiveCatalog("live");
      const dir = await ensureCatalogCloned(store, "live", liveRoot);

      expect(dir).toBe(path.join(liveRoot, "live"));
      expect(store.get("live")?.status).toBe("ok");
      const plugins = await listPlugins(store, "live", liveRoot);
      expect(plugins.map((p) => p.name)).toEqual(["first"]);
    });

    it("rebuilds a clone it cannot update, instead of retrying the same failure forever", async () => {
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      await commitOriginCatalog(originDir, "second");

      const cacheDir = path.join(liveRoot, "live");
      fs.writeFileSync(path.join(cacheDir, ".git", "config"), "this is not a git config\n[");

      const dir = await ensureCatalogCloned(store, "live", liveRoot);

      expect(dir).toBe(cacheDir);
      expect(store.get("live")?.status).toBe("ok");
      expect(store.get("live")?.fetchError).toBeUndefined();
      const plugins = await listPlugins(store, "live", liveRoot);
      expect(plugins.map((p) => p.name)).toEqual(["second"]);
      expect(fs.readdirSync(liveRoot)).toEqual(["live"]);
    });

    it("recovers from a clone whose .git is not writable", async () => {
      // Root bypasses this mode-bit failure.
      if (process.getuid?.() === 0) return;
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      await commitOriginCatalog(originDir, "second");

      fs.chmodSync(path.join(liveRoot, "live", ".git", "objects"), 0o500);
      try {
        await expect(simpleGit(path.join(liveRoot, "live")).fetch("origin")).rejects.toThrow(
          /insufficient permission for adding an object/,
        );

        await ensureCatalogCloned(store, "live", liveRoot);
        expect(store.get("live")?.status).toBe("ok");
        const plugins = await listPlugins(store, "live", liveRoot);
        expect(plugins.map((p) => p.name)).toEqual(["second"]);
        expect(fs.readdirSync(liveRoot).filter((n) => n.startsWith("live.stale-"))).toHaveLength(1);
      } finally {
        // Restore permissions on moved copies so teardown can delete them.
        for (const name of fs.readdirSync(liveRoot)) {
          const objects = path.join(liveRoot, name, ".git", "objects");
          if (fs.existsSync(objects)) fs.chmodSync(objects, 0o700);
        }
      }
    });

    it("keeps serving a readable stale cache when the remote is unreachable", async () => {
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      fs.rmSync(originDir, { recursive: true, force: true });

      const dir = await ensureCatalogCloned(store, "live", liveRoot);

      expect(dir).toBe(path.join(liveRoot, "live"));
      expect(store.get("live")?.status).toBe("fetch-failed");
      expect(store.get("live")?.fetchError).toMatch(/rebuilding the cache also failed/);
      const plugins = await listPlugins(store, "live", liveRoot);
      expect(plugins.map((p) => p.name)).toEqual(["first"]);
    });

    it("does not destroy a working cache when the rebuild clone fails", async () => {
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      const cacheDir = path.join(liveRoot, "live");
      fs.writeFileSync(path.join(cacheDir, ".git", "config"), "not a git config\n[");
      fs.rmSync(originDir, { recursive: true, force: true });

      await ensureCatalogCloned(store, "live", liveRoot);

      expect(fs.existsSync(path.join(cacheDir, ".claude-plugin", "marketplace.json"))).toBe(true);
      expect(fs.readdirSync(liveRoot)).toEqual(["live"]);
    });

    it("serializes concurrent callers so one rebuild cannot sweep another's staging clone", async () => {
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      await commitOriginCatalog(originDir, "second");
      const cacheDir = path.join(liveRoot, "live");
      fs.writeFileSync(path.join(cacheDir, ".git", "config"), "not a git config\n[");

      const results = await Promise.all([
        ensureCatalogCloned(store, "live", liveRoot),
        ensureCatalogCloned(store, "live", liveRoot),
        ensureCatalogCloned(store, "live", liveRoot),
      ]);

      expect(results).toEqual([cacheDir, cacheDir, cacheDir]);
      expect(store.get("live")?.status).toBe("ok");
      const plugins = await listPlugins(store, "live", liveRoot);
      expect(plugins.map((p) => p.name)).toEqual(["second"]);
      expect(fs.readdirSync(liveRoot)).toEqual(["live"]);
    });

    it("drops the staging clone when the cache dir cannot be renamed aside", async () => {
      // Root bypasses this mode-bit failure.
      if (process.getuid?.() === 0) return;
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      const cacheDir = path.join(liveRoot, "live");
      fs.writeFileSync(path.join(cacheDir, ".git", "config"), "not a git config\n[");
      fs.chmodSync(liveRoot, 0o500);
      try {
        const dir = await ensureCatalogCloned(store, "live", liveRoot);
        expect(dir).toBe(cacheDir);
        expect(store.get("live")?.status).toBe("fetch-failed");
      } finally {
        fs.chmodSync(liveRoot, 0o700);
      }
      expect(fs.readdirSync(liveRoot)).toEqual(["live"]);
    });

    it("does not serve a stale cache whose manifest no longer parses", async () => {
      seedLiveCatalog("live");
      await ensureCatalogCloned(store, "live", liveRoot);
      const cacheDir = path.join(liveRoot, "live");
      fs.writeFileSync(path.join(cacheDir, ".claude-plugin", "marketplace.json"), "{ not json");
      fs.writeFileSync(path.join(cacheDir, ".git", "config"), "not a git config\n[");
      fs.rmSync(originDir, { recursive: true, force: true });

      await expect(ensureCatalogCloned(store, "live", liveRoot)).rejects.toThrow(ServiceError);
      expect(store.get("live")?.status).toBe("fetch-failed");
    });

    it("throws when the cache holds nothing usable and the clone fails", async () => {
      seedLiveCatalog("live");
      fs.rmSync(originDir, { recursive: true, force: true });

      await expect(ensureCatalogCloned(store, "live", liveRoot)).rejects.toThrow(ServiceError);
      expect(store.get("live")?.status).toBe("fetch-failed");
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
