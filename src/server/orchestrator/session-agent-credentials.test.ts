import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isOpenCodeHarness } from "../shared/opencode-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureSessionAccountCredentials,
  provisionAgentCredentials,
  provisionProviderAccountCredentials,
  provisionSubAgentSpawnHome,
  readSessionAccountMarker,
  readSessionResidentRoute,
  revokeSessionProviderCredentials,
  subAgentSpawnHomeDir,
  writeSessionAccountMarker,
  writeSessionResidentRoute,
} from "./session-agent-credentials.js";
import { AGENT_CREDENTIAL_PATHS, agentCredentialDirs } from "./session-credentials-scaffold.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";
import { SUBTREE_STATE_SUBPATHS } from "./token-sync-manager.js";
import type { AgentId } from "../shared/types/agent-types.js";

describe("ensureSessionAccountCredentials (docs/260-turn-level-account-routing req 4)", () => {
  let root: string;
  const SESSION = "s1";

  const accountRoot = (accountId: string): string =>
    path.join(root, "provider-accounts", "claude", accountId);
  const sessionDir = (): string => path.join(root, "sessions", SESSION);
  const sessionToken = (): string | null => {
    try {
      return fs.readFileSync(path.join(sessionDir(), ".claude", ".credentials.json"), "utf8");
    } catch {
      return null;
    }
  };

  function seedAccount(accountId: string, token: string): void {
    fs.mkdirSync(path.join(accountRoot(accountId), ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(accountRoot(accountId), ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-account-marker-"));
    fs.mkdirSync(sessionDir(), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("provisions a fresh subtree and records the marker", () => {
    seedAccount("acct_a", "tok-a");

    const outcome = ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    expect(outcome).toBe("provisioned");
    expect(sessionToken()).toContain("tok-a");
    expect(readSessionAccountMarker(root, SESSION).claude).toBe("acct_a");
  });

  it("is a no-op when the marker already names the chosen account", () => {
    seedAccount("acct_a", "tok-a");
    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");
    fs.writeFileSync(
      path.join(sessionDir(), ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-a-rotated" } }),
    );

    const outcome = ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    expect(outcome).toBe("match");
    expect(sessionToken()).toContain("tok-a-rotated");
  });

  it("REPLACES a subtree recorded to a different account — the poisoning class (req 4)", () => {
    seedAccount("acct_a", "tok-a");
    seedAccount("acct_b", "tok-b");
    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    const outcome = ensureSessionAccountCredentials(root, SESSION, "claude", "acct_b");

    expect(outcome).toBe("replaced");
    expect(sessionToken()).toContain("tok-b");
    expect(readSessionAccountMarker(root, SESSION).claude).toBe("acct_b");
  });

  it("preserves conversation state across a replacement (req 7)", () => {
    seedAccount("acct_a", "tok-a");
    seedAccount("acct_b", "tok-b");
    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");
    const conv = path.join(sessionDir(), ".claude", "projects", "-workspace");
    fs.mkdirSync(conv, { recursive: true });
    fs.writeFileSync(path.join(conv, "conv-1.jsonl"), "turn1\n");

    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_b");

    expect(fs.readFileSync(path.join(conv, "conv-1.jsonl"), "utf8")).toBe("turn1\n");
    expect(sessionToken()).toContain("tok-b");
  });

  it("ADOPTS a pre-260 subtree whose token byte-matches the chosen account", () => {
    seedAccount("acct_a", "tok-a");
    fs.mkdirSync(path.join(sessionDir(), ".claude"), { recursive: true });
    fs.copyFileSync(
      path.join(accountRoot("acct_a"), ".claude", ".credentials.json"),
      path.join(sessionDir(), ".claude", ".credentials.json"),
    );

    const outcome = ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    expect(outcome).toBe("adopted");
    expect(readSessionAccountMarker(root, SESSION).claude).toBe("acct_a");
  });

  it("REPLACES an unidentifiable pre-260 copy — the root is authoritative", () => {
    seedAccount("acct_a", "tok-a");
    fs.mkdirSync(path.join(sessionDir(), ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir(), ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "who-knows" } }),
    );

    const outcome = ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    expect(outcome).toBe("replaced");
    expect(sessionToken()).toContain("tok-a");
  });

  it("disconnecting managed ChatGPT preserves a terminal OpenCode login and conversation", () => {
    const terminal = path.join(sessionDir(), ".local/share/opencode");
    const managed = path.join(terminal, "shipit-data/opencode");
    fs.mkdirSync(managed, { recursive: true });
    fs.writeFileSync(path.join(terminal, "auth.json"), "terminal-owned");
    fs.writeFileSync(path.join(managed, "auth.json"), "managed-access");
    fs.writeFileSync(path.join(managed, "opencode.db"), "conversation");
    writeSessionAccountMarker(root, SESSION, "opencode", "account-a");
    revokeSessionProviderCredentials(root, SESSION, "opencode");
    expect(fs.readFileSync(path.join(terminal, "auth.json"), "utf8")).toBe("terminal-owned");
    expect(fs.readFileSync(path.join(managed, "opencode.db"), "utf8")).toBe("conversation");
    expect(fs.existsSync(path.join(managed, "auth.json"))).toBe(false);
    expect(readSessionAccountMarker(root, SESSION).opencode).toBeUndefined();
  });

  it("disconnecting managed ChatGPT from OpenCode 2 keeps its database and leaves v1's root alone", () => {
    const v1 = path.join(sessionDir(), ".local/share/opencode/shipit-data/opencode");
    const v2 = path.join(sessionDir(), ".local/share/opencode2");
    fs.mkdirSync(v1, { recursive: true });
    fs.mkdirSync(path.join(v2, "shipit-account", "opencode"), { recursive: true });
    fs.mkdirSync(path.join(v2, "shipit-data", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(v1, "auth.json"), "v1-managed");
    fs.writeFileSync(path.join(v2, "shipit-account", "opencode", "auth.json"), "v2-projection");
    fs.writeFileSync(path.join(v2, "shipit-data", "opencode", "opencode.db"), "conversation");
    writeSessionAccountMarker(root, SESSION, "opencode2", "account-a");
    revokeSessionProviderCredentials(root, SESSION, "opencode2");
    expect(fs.existsSync(path.join(v2, "shipit-account", "opencode", "auth.json"))).toBe(false);
    expect(fs.readFileSync(path.join(v2, "shipit-data", "opencode", "opencode.db"), "utf8")).toBe("conversation");
    expect(fs.readFileSync(path.join(v1, "auth.json"), "utf8")).toBe("v1-managed");
    expect(readSessionAccountMarker(root, SESSION).opencode2).toBeUndefined();
  });

  it("revocation clears the marker so the next turn reprovisions", () => {
    seedAccount("acct_a", "tok-a");
    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    revokeSessionProviderCredentials(root, SESSION, "claude");

    expect(readSessionAccountMarker(root, SESSION).claude).toBeUndefined();
    expect(sessionToken()).toBeNull();
    expect(ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a")).toBe("provisioned");
  });

  it("markers are per agent — one agent's write never touches the other's", () => {
    writeSessionAccountMarker(root, SESSION, "claude", "acct_a");
    writeSessionAccountMarker(root, SESSION, "codex", "acct_z");
    writeSessionAccountMarker(root, SESSION, "claude", null);

    const marker = readSessionAccountMarker(root, SESSION);
    expect(marker.claude).toBeUndefined();
    expect(marker.codex).toBe("acct_z");
  });

  it("a marker written for ANY supported agent reads back unchanged (planning#443)", () => {
    const allAgentIds = Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[];

    for (const agentId of allAgentIds) {
      writeSessionAccountMarker(root, SESSION, agentId, `acct_${agentId}`);
      expect(readSessionAccountMarker(root, SESSION)[agentId]).toBe(`acct_${agentId}`);
    }

    expect(readSessionAccountMarker(root, SESSION)).toEqual(
      Object.fromEntries(allAgentIds.map((id) => [id, `acct_${id}`])),
    );
  });

  it("provisionProviderAccountCredentials records the marker itself", () => {
    seedAccount("acct_a", "tok-a");
    provisionProviderAccountCredentials(root, SESSION, "claude", "acct_a");
    expect(readSessionAccountMarker(root, SESSION).claude).toBe("acct_a");
  });

  describe("session resident-route record", () => {
    it("round-trips per agent and overwrites on a new spawn", () => {
      writeSessionResidentRoute(root, SESSION, "claude", { kind: "reserved", id: "cred_glm" });
      writeSessionResidentRoute(root, SESSION, "codex", { kind: "account", id: "acct_z" });
      expect(readSessionResidentRoute(root, SESSION).claude).toEqual({ kind: "reserved", id: "cred_glm" });
      expect(readSessionResidentRoute(root, SESSION).codex).toEqual({ kind: "account", id: "acct_z" });

      writeSessionResidentRoute(root, SESSION, "claude", { kind: "account", id: "acct_a" });
      expect(readSessionResidentRoute(root, SESSION).claude).toEqual({ kind: "account", id: "acct_a" });
      expect(readSessionResidentRoute(root, SESSION).codex).toEqual({ kind: "account", id: "acct_z" });
    });

    it("reads an absent or corrupt file as empty", () => {
      expect(readSessionResidentRoute(root, "nope")).toEqual({});
      fs.writeFileSync(path.join(root, "sessions", SESSION, ".shipit-resident-route.json"), "not-json");
      expect(readSessionResidentRoute(root, SESSION)).toEqual({});
    });
  });

  describe("credential directories exist even with nothing to copy", () => {
    it("materializes every declared credential DIR for every agent", () => {
      const allAgentIds = Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[];
      for (const agentId of allAgentIds) {
        // OpenCode account provisioning deliberately refuses absent source auth.
        if (isOpenCodeHarness(agentId)) {
          const source = path.join(root, "provider-accounts", "codex", `acct_${agentId}`, ".codex");
          fs.mkdirSync(source, { recursive: true });
          const access_token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
          fs.writeFileSync(path.join(source, "auth.json"), JSON.stringify({ tokens: { access_token } }));
        }
        provisionProviderAccountCredentials(root, SESSION, agentId, `acct_${agentId}`);
        for (const rel of agentCredentialDirs(agentId)) {
          const dir = path.join(sessionDir(), rel);
          expect(fs.existsSync(dir), `${agentId}: ${rel} was not created`).toBe(true);
          expect(fs.statSync(dir).isDirectory(), `${agentId}: ${rel} is not a directory`).toBe(true);
        }
      }
    });

    it("never treats a FILE-shaped declared path as a directory, for any agent", () => {
      const looksLikeAFile = (rel: string): boolean => {
        const leaf = rel.split("/").pop() ?? rel;
        return leaf.replace(/^\./, "").includes(".");
      };
      for (const agentId of Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[]) {
        for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
          if (!looksLikeAFile(rel)) continue;
          expect(
            agentCredentialDirs(agentId),
            `'${rel}' is file-shaped but would be created as a directory — add it to AGENT_CREDENTIAL_FILES`,
          ).not.toContain(rel);
        }
      }
      expect(AGENT_CREDENTIAL_PATHS.claude).toContain(".claude.json");
      expect(agentCredentialDirs("claude")).not.toContain(".claude.json");
      provisionProviderAccountCredentials(root, SESSION, "claude", "acct_a");
      const claudeJson = path.join(sessionDir(), ".claude.json");
      if (fs.existsSync(claudeJson)) {
        expect(fs.statSync(claudeJson).isDirectory()).toBe(false);
      }
    });

    it("does not overwrite a subtree that WAS copied", () => {
      seedAccount("acct_a", "tok-a");
      provisionProviderAccountCredentials(root, SESSION, "claude", "acct_a");
      expect(sessionToken()).toContain("tok-a");
    });
  });
});

describe("copying a source root leaves its conversation state behind (planning#698)", () => {
  let root: string;
  const SESSION = "s1";
  const ACCOUNT = "acct_a";
  // OpenCode accounts are delivered as a projection, not as a copy of the subtree.
  const COPIED_AGENTS = (Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[]).filter((id) => !isOpenCodeHarness(id));

  const stateEntries = (agentId: AgentId): string[] =>
    AGENT_CREDENTIAL_PATHS[agentId].flatMap((rel) =>
      (SUBTREE_STATE_SUBPATHS[rel] ?? []).map((sub) => path.join(rel, sub)));

  // Every state entry, plus a credential-shaped sibling beside each one.
  function seedAccountRoot(agentId: AgentId, source = providerAccountCredentialRoot(root, agentId, ACCOUNT)): void {
    for (const entry of stateEntries(agentId)) {
      const target = path.join(source, entry);
      if (path.extname(entry)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "account-state");
      } else {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "rollout.jsonl"), "account-state");
      }
      fs.writeFileSync(path.join(source, path.dirname(entry), "keep.json"), "credential");
    }
  }

  function expectCredentialsWithoutState(agentId: AgentId, dest: string): void {
    expect(stateEntries(agentId).length).toBeGreaterThan(0);
    for (const entry of stateEntries(agentId)) {
      expect(fs.existsSync(path.join(dest, entry)), `${entry} was copied`).toBe(false);
      expect(fs.existsSync(path.join(dest, path.dirname(entry), "keep.json")), `${entry}'s sibling was not copied`)
        .toBe(true);
    }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-state-copy-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(COPIED_AGENTS)("%s: a session provisioned from an account gets none of its state", (agentId) => {
    seedAccountRoot(agentId);

    provisionProviderAccountCredentials(root, SESSION, agentId, ACCOUNT);

    expectCredentialsWithoutState(agentId, path.join(root, "sessions", SESSION));
  });

  it.each(COPIED_AGENTS)("%s: a consultation spawn home gets none of the account's state", (agentId) => {
    seedAccountRoot(agentId);

    provisionSubAgentSpawnHome(root, SESSION, "spawn-1", agentId, ACCOUNT);

    expectCredentialsWithoutState(agentId, subAgentSpawnHomeDir(root, SESSION, "spawn-1"));
  });

  it.each(Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[])(
    "%s: a copy from the global credentials root gets none of its state",
    (agentId) => {
      seedAccountRoot(agentId, root);

      provisionAgentCredentials(root, SESSION, agentId);

      expectCredentialsWithoutState(agentId, path.join(root, "sessions", SESSION));
    },
  );

  it("leaves a naming run's Codex rollout and Claude transcript in the account root", () => {
    const codexRoot = providerAccountCredentialRoot(root, "codex", ACCOUNT);
    const rollout = path.join(".codex", "sessions", "2026", "10", "15", "rollout-2026-10-15T00-00-00-t.jsonl");
    fs.mkdirSync(path.dirname(path.join(codexRoot, rollout)), { recursive: true });
    fs.writeFileSync(path.join(codexRoot, rollout), "{}\n");
    fs.writeFileSync(path.join(codexRoot, ".codex", "auth.json"), "{}");
    const claudeRoot = providerAccountCredentialRoot(root, "claude", ACCOUNT);
    const transcript = path.join(".claude", "projects", "-tmp", "naming.jsonl");
    fs.mkdirSync(path.dirname(path.join(claudeRoot, transcript)), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, transcript), "{}\n");

    provisionProviderAccountCredentials(root, SESSION, "codex", ACCOUNT);
    provisionProviderAccountCredentials(root, SESSION, "claude", ACCOUNT);

    const sessionDir = path.join(root, "sessions", SESSION);
    expect(fs.existsSync(path.join(sessionDir, ".codex", "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, rollout))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, transcript))).toBe(false);
  });

  it("skips state reached through symlinks, in the subtree root and in the state entry", () => {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "rollouts"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "rollouts", "rollout.jsonl"), "{}\n");
    fs.mkdirSync(path.join(elsewhere, "codex-home"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "codex-home", "auth.json"), "{}");
    fs.symlinkSync(path.join(elsewhere, "rollouts"), path.join(elsewhere, "codex-home", "sessions"));
    const accountRoot = providerAccountCredentialRoot(root, "codex", ACCOUNT);
    fs.mkdirSync(accountRoot, { recursive: true });
    fs.symlinkSync(path.join(elsewhere, "codex-home"), path.join(accountRoot, ".codex"));

    provisionProviderAccountCredentials(root, SESSION, "codex", ACCOUNT);

    const codexDir = path.join(root, "sessions", SESSION, ".codex");
    expect(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(path.join(codexDir, "sessions"))).toBe(false);
  });

  it("an account switch keeps the session's own history over the new account's", () => {
    const sessionHistory = path.join(root, "sessions", SESSION, ".claude", "history.jsonl");
    for (const accountId of ["acct_a", "acct_b"]) {
      const claudeDir = path.join(providerAccountCredentialRoot(root, "claude", accountId), ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, ".credentials.json"), `{"token":"${accountId}"}`);
      fs.writeFileSync(path.join(claudeDir, "history.jsonl"), `${accountId}-history\n`);
    }
    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");
    fs.writeFileSync(sessionHistory, "session-history\n");

    expect(ensureSessionAccountCredentials(root, SESSION, "claude", "acct_b")).toBe("replaced");

    expect(fs.readFileSync(sessionHistory, "utf8")).toBe("session-history\n");
  });
});
