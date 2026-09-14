import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSetting, projectSetting } from "../../shared/settings-catalogue/index.js";
import { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import { globalSystemPromptPath, writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { settingBaseline, baselineMatches } from "./settings-baseline.js";
import type { SettingBaselineDeps } from "./settings-baseline.js";

/**
 * The baseline an apply compares against (docs/299-agent-settings-access,
 * plan.md → Applying), taken when a card is written and again before its write.
 */

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-baseline-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function deps(credentialStore?: CredentialStore): SettingBaselineDeps {
  return {
    appWorkspaceDir: tmpDir(),
    ...(credentialStore ? { credentialStore } : {}),
  };
}

describe("settingBaseline", () => {
  it("is a revision over the WHOLE stored value, not over what the read emits", async () => {
    const store = new CredentialStore(tmpDir());
    const d = deps(store);
    const declaration = findSetting("mcp.servers[].url")!;

    store.setMcpServer("notion", {
      name: "notion", type: "http", enabled: true,
      url: "https://mcp.example.com/v1/team-a?token=first",
    });
    const before = await settingBaseline(d, { key: "mcp.servers[].url", item: "notion" });
    const displayedBefore = projectSetting(declaration, (store.getMcpServer("notion") as { url: string }).url);

    // The SAME host, a different path and query. The declaration emits scheme
    // and host only, so everything the user can see is unchanged.
    store.setMcpServer("notion", {
      name: "notion", type: "http", enabled: true,
      url: "https://mcp.example.com/v1/team-b?token=second",
    });
    const after = await settingBaseline(d, { key: "mcp.servers[].url", item: "notion" });
    const displayedAfter = projectSetting(declaration, (store.getMcpServer("notion") as { url: string }).url);

    // This is the bug the baseline exists for: comparing the DISPLAYED value
    // says nothing changed, so a card approved against the old configuration
    // would apply over the new one.
    expect(displayedAfter).toEqual(displayedBefore);
    expect(baselineMatches(before, after)).toBe(false);
  });

  it("covers a field the declaration drops entirely, not only the projected one", async () => {
    const store = new CredentialStore(tmpDir());
    const d = deps(store);
    store.setMcpServer("notion", {
      name: "notion", type: "stdio", enabled: true, command: "npx", args: ["--token=first"],
    });
    const before = await settingBaseline(d, { key: "mcp.servers[].enabled", item: "notion" });

    store.setMcpServer("notion", {
      name: "notion", type: "stdio", enabled: true, command: "npx", args: ["--token=second"],
    });
    const after = await settingBaseline(d, { key: "mcp.servers[].enabled", item: "notion" });

    expect(baselineMatches(before, after)).toBe(false);
  });

  it("is stable for an unchanged value, so a proposal is not stale for no reason", async () => {
    const store = new CredentialStore(tmpDir());
    const d = deps(store);
    store.setMcpServer("notion", { name: "notion", type: "http", enabled: true, url: "https://mcp.example.com/v1" });

    const a = await settingBaseline(d, { key: "mcp.servers[].url", item: "notion" });
    const b = await settingBaseline(d, { key: "mcp.servers[].url", item: "notion" });
    expect(baselineMatches(a, b)).toBe(true);
  });

  it("covers a declared scalar with no reader of its own (req 7)", async () => {
    const store = new CredentialStore(tmpDir());
    const d = deps(store);

    const before = await settingBaseline(d, { key: "advanced.enableSubAgents" });
    store.setDeclaredSetting("advanced.enableSubAgents", false);
    const after = await settingBaseline(d, { key: "advanced.enableSubAgents" });

    expect(before.kind).toBe("revision");
    expect(baselineMatches(before, after)).toBe(false);
  });

  it("moves when the allowlist gains a host, and when a built-in default is suppressed", async () => {
    const db = new DatabaseManager(":memory:");
    const egressAllowlistStore = new EgressAllowlistStore(db);
    const d = { ...deps(), egressAllowlistStore };

    const empty = await settingBaseline(d, { key: "network.egress.hosts" });
    egressAllowlistStore.addHost(EGRESS_GLOBAL_SCOPE, "api.example.com");
    const added = await settingBaseline(d, { key: "network.egress.hosts" });
    expect(baselineMatches(empty, added)).toBe(false);

    // A suppressed default changes the effective list without changing the rows,
    // so it has to be part of the revision.
    egressAllowlistStore.suppressDefault("registry.npmjs.org");
    const suppressed = await settingBaseline(d, { key: "network.egress.hosts" });
    expect(baselineMatches(added, suppressed)).toBe(false);
  });

  it("says `unknown` rather than inventing one, and an unknown never matches itself", async () => {
    const d = deps();
    const noStore = await settingBaseline(d, { key: "mcp.servers[].enabled", item: "notion" });
    expect(noStore.kind).toBe("unknown");
    expect(baselineMatches(noStore, noStore)).toBe(false);

    const unnamed = await settingBaseline(deps(new CredentialStore(tmpDir())), { key: "mcp.servers[].enabled" });
    expect(unnamed).toEqual({ kind: "unknown", reason: expect.stringContaining("server's name") });

    const undeclared = await settingBaseline(d, { key: "not.a.setting" });
    expect(undeclared.kind).toBe("unknown");
  });

  it("tells an ABSENT instructions file from an unreadable one", async () => {
    const workspace = tmpDir();
    const d = { ...deps(new CredentialStore(tmpDir())), appWorkspaceDir: workspace };
    const key = "instructions.userInstructions";

    const absent = await settingBaseline(d, { key });
    expect(absent.kind).toBe("revision");

    await writeGlobalSystemPrompt(workspace, "Be brief.");
    const written = await settingBaseline(d, { key });
    expect(baselineMatches(absent, written)).toBe(false);

    // The display reader answers "no instructions" for an unreadable file, which
    // is a real value. Baselining that would make two failed reads compare equal.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const file = globalSystemPromptPath(workspace);
    fs.chmodSync(file, 0o000);
    const unreadable = await settingBaseline(d, { key });
    fs.chmodSync(file, 0o600);

    expect(unreadable.kind).toBe("unknown");
    expect(baselineMatches(unreadable, absent)).toBe(false);
  });

  it("has none for a browser-local setting, because the server holds no value", async () => {
    const result = await settingBaseline(deps(), { key: "voice.inputEnabled" });
    expect(result).toEqual({
      kind: "unknown",
      reason: expect.stringContaining("browser"),
    });
  });
});

describe("a setting stored per (service, billing mode)", () => {
  it("has a baseline of its own, so a card about it is not refused for want of one", async () => {
    // Without a reader these answer `unknown`, and propose refuses every card
    // for a setting it cannot tell has moved — the operation exists and nothing
    // can reach it.
    const store = new CredentialStore(tmpDir());
    const d = deps(store);
    const target = { key: "services.failoverCutoff.session", item: "anthropic:sub" };

    const before = await settingBaseline(d, target);
    expect(before.kind).toBe("revision");

    store.setFailoverCutoffs("anthropic", "sub", { session: 50 });
    const after = await settingBaseline(d, target);

    expect(after.kind).toBe("revision");
    expect(baselineMatches(before, after)).toBe(false);
  });

  it("says so when the address is not a service and a billing mode", async () => {
    const baseline = await settingBaseline(deps(new CredentialStore(tmpDir())), {
      key: "services.accountSelectionMode",
      item: "anthropic",
    });
    expect(baseline).toMatchObject({ kind: "unknown" });
  });
});
