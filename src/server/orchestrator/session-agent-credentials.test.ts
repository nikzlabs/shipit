import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureSessionAccountCredentials,
  provisionProviderAccountCredentials,
  readSessionAccountMarker,
  readSessionResidentRoute,
  revokeSessionProviderCredentials,
  writeSessionAccountMarker,
  writeSessionResidentRoute,
} from "./session-agent-credentials.js";
import { AGENT_CREDENTIAL_PATHS, agentCredentialDirs } from "./session-credentials-scaffold.js";
import type { AgentId } from "../shared/types/agent-types.js";

/**
 * docs/260-turn-level-account-routing req 4 — the per-turn credential identity check. The session's
 * subtree must belong to the CHOSEN account before the turn spawns, whatever
 * it held before; the recorded marker (not token bytes, not a session row) is
 * what says whose credentials the subtree holds.
 */
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
    // The session's CLI has since rotated its token — a same-account
    // difference the per-turn freshness sync owns, not this check.
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

    // `--resume` still finds the conversation; only the credentials moved.
    expect(fs.readFileSync(path.join(conv, "conv-1.jsonl"), "utf8")).toBe("turn1\n");
    expect(sessionToken()).toContain("tok-b");
  });

  it("ADOPTS a pre-260 subtree whose token byte-matches the chosen account", () => {
    seedAccount("acct_a", "tok-a");
    // A legacy session: credentials on disk, no marker.
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

  it("revocation clears the marker so the next turn reprovisions", () => {
    seedAccount("acct_a", "tok-a");
    ensureSessionAccountCredentials(root, SESSION, "claude", "acct_a");

    revokeSessionProviderCredentials(root, SESSION, "claude");

    expect(readSessionAccountMarker(root, SESSION).claude).toBeUndefined();
    expect(sessionToken()).toBeNull();
    // And the next turn starts clean.
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
    // The list is derived from the same compile-forced Record the reader now
    // filters through, so an AgentId added tomorrow is covered here without an
    // edit — the hand-listed filter this guards against dropped "grok" with no
    // test ever noticing.
    const allAgentIds = Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[];

    for (const agentId of allAgentIds) {
      writeSessionAccountMarker(root, SESSION, agentId, `acct_${agentId}`);
      expect(readSessionAccountMarker(root, SESSION)[agentId]).toBe(`acct_${agentId}`);
    }

    // The full map survives too — each write's read-modify-write must not drop
    // the entries earlier writes left for the other agents.
    expect(readSessionAccountMarker(root, SESSION)).toEqual(
      Object.fromEntries(allAgentIds.map((id) => [id, `acct_${id}`])),
    );
  });

  it("provisionProviderAccountCredentials records the marker itself", () => {
    seedAccount("acct_a", "tok-a");
    provisionProviderAccountCredentials(root, SESSION, "claude", "acct_a");
    expect(readSessionAccountMarker(root, SESSION).claude).toBe("acct_a");
  });

  // docs/260 §5 — the resident-route record is the identity a STRING-delivered
  // credential leaves behind for post-restart adoption (reqs 11/13). The
  // account marker cannot carry it: the marker records which account's subtree
  // COPY is on disk, and a string credential authenticates from spawn env
  // without touching the subtree.
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

  /**
   * planning#444 — a key-billed harness has nothing to copy, and the image's
   * `~/.<agent>` symlink is created unconditionally. So a provisioning pass that
   * only ever COPIES leaves the link dangling, and a dangling symlink is not a
   * harmless absence: it is an existing directory entry, so the CLI's own
   * `mkdir` fails and the harness dies at startup. Grok hit this after OpenCode
   * hit the same shape (docs/270), which is why the guard is written against
   * the whole `AgentId` union rather than against grok.
   */
  describe("credential directories exist even with nothing to copy", () => {
    it("materializes every declared credential DIR for every agent", () => {
      const allAgentIds = Object.keys(AGENT_CREDENTIAL_PATHS) as AgentId[];
      for (const agentId of allAgentIds) {
        // No source subtree anywhere — the key-billed shape.
        provisionProviderAccountCredentials(root, SESSION, agentId, `acct_${agentId}`);
        for (const rel of agentCredentialDirs(agentId)) {
          const dir = path.join(sessionDir(), rel);
          expect(fs.existsSync(dir), `${agentId}: ${rel} was not created`).toBe(true);
          expect(fs.statSync(dir).isDirectory(), `${agentId}: ${rel} is not a directory`).toBe(true);
        }
      }
    });

    it("never treats a FILE-shaped declared path as a directory, for any agent", () => {
      // An empty directory where the CLI expects a file is worse than the
      // dangling link this fixes: the CLI would parse a directory as its user
      // config and fail every turn. `.claude.json` is the only such path today,
      // and asserting that one name would pin nothing for the NEXT one — the
      // deny-list is exactly the kind of table a later edit forgets.
      //
      // So the check is mechanical: a declared path whose final segment carries
      // an extension (a dot after the leading dot that makes it hidden) is
      // file-shaped, and must have been excluded. `.claude` and `.grok` are
      // hidden directories, not extensions; `.local/share/opencode` has neither.
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
      // And the known one, named, so the assertion above cannot go vacuous.
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
