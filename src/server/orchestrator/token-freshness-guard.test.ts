// Fixtures: Claude captured 2026-08-20; Grok captured 2026-08-19 (device auth).
// Codex is reconstructed from docs/154 and its auth manager, not a current capture.
// Tokens are placeholders; JWT gitleaks markers sit in the unparsed signature.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId } from "../shared/types/agent-types.js";
import {
  AGENT_TOKEN_FILES,
  TOKEN_FRESHNESS,
  isBlankedClaudeCredential,
  sessionTokenIsAheadOfSource,
  syncAgentTokenIn,
  syncAgentTokenBack,
  syncSubAgentSpawnHomeTokenBack,
} from "./token-sync-manager.js";
import { perSessionCredentialsDir } from "./session-credentials.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "token-freshness",
);

const DECLARED_AGENTS = Object.keys(TOKEN_FRESHNESS) as AgentId[];

const ALIEN_CREDENTIAL = JSON.stringify({ some_future_shape: { token: "opaque" } });

const SOURCE_MARKER = "__shipit_fixture_source_marker";

function fixturePath(agentId: AgentId): string {
  return path.join(FIXTURE_DIR, `${agentId}.json`);
}

function markedSource(agentId: AgentId): string {
  const parsed = JSON.parse(fs.readFileSync(fixturePath(agentId), "utf-8")) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, [SOURCE_MARKER]: "SOURCE" });
}

describe("planning#449 — token freshness readers against real credential files", () => {
  let root: string;
  const sid = "session-freshness-guard";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-freshness-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(agentId: AgentId, sessionContent: string | null): string[] {
    const sessionDir = perSessionCredentialsDir(root, sid);
    const rels = AGENT_TOKEN_FILES[agentId] ?? [];
    const source = markedSource(agentId);
    for (const rel of rels) {
      const src = path.join(root, rel);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, source);
      const dst = path.join(sessionDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (sessionContent !== null) fs.writeFileSync(dst, sessionContent);
    }
    return rels.map((rel) => path.join(sessionDir, rel));
  }

  function unorderableLines(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls
      .map((call) => call.join(" "))
      .filter((line) => line.includes("token-freshness=unorderable"));
  }

  it("every agent on the token-sync path declares a freshness reader", () => {
    for (const agentId of Object.keys(AGENT_TOKEN_FILES) as AgentId[]) {
      expect(TOKEN_FRESHNESS[agentId], `${agentId} has token files but no freshness reader`)
        .toBeTypeOf("function");
    }
  });

  it("every declared reader has a committed real-shape fixture", () => {
    for (const agentId of DECLARED_AGENTS) {
      expect(fs.existsSync(fixturePath(agentId)), `missing fixture for ${agentId}`).toBe(true);
    }
  });

  describe.each(DECLARED_AGENTS)("%s", (agentId) => {
    const read = TOKEN_FRESHNESS[agentId]!;

    it("orders the real captured credential file", () => {
      const at = read(fixturePath(agentId));
      expect(at, `${agentId}'s freshness reader returned null for its real file`).not.toBeNull();
      expect(Number.isFinite(at!)).toBe(true);
      expect(at!).toBeGreaterThan(0);
    });

    it("drives both sync guards without an unorderable reading", () => {
      seed(agentId, fs.readFileSync(fixturePath(agentId), "utf-8"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        syncAgentTokenIn(root, sid, agentId);
        syncAgentTokenBack(root, sid, agentId);
        expect(unorderableLines(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it("refuses to overwrite a session credential it cannot order, and says so", () => {
      const sessionFiles = seed(agentId, ALIEN_CREDENTIAL);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        syncAgentTokenIn(root, sid, agentId);
        for (const file of sessionFiles) {
          expect(fs.readFileSync(file, "utf-8")).not.toContain(SOURCE_MARKER);
        }
        expect(unorderableLines(warn).length).toBeGreaterThan(0);
        expect(unorderableLines(warn)[0]).toContain("outcome=refused-copy");
      } finally {
        warn.mockRestore();
      }
    });

    it("still copies over a session file that is not a credential", () => {
      const sessionFiles = seed(agentId, "not json at all");
      syncAgentTokenIn(root, sid, agentId);
      for (const file of sessionFiles) {
        expect(fs.readFileSync(file, "utf-8")).toContain(SOURCE_MARKER);
      }
    });

    it("refuses to publish over a source credential it cannot order", () => {
      const sessionDir = perSessionCredentialsDir(root, sid);
      const rels = AGENT_TOKEN_FILES[agentId] ?? [];
      const captured = fs.readFileSync(fixturePath(agentId), "utf-8");
      for (const rel of rels) {
        const src = path.join(root, rel);
        fs.mkdirSync(path.dirname(src), { recursive: true });
        fs.writeFileSync(src, ALIEN_CREDENTIAL);
        const dst = path.join(sessionDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, captured);
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        syncAgentTokenBack(root, sid, agentId);
        for (const rel of rels) {
          expect(fs.readFileSync(path.join(root, rel), "utf-8")).toBe(ALIEN_CREDENTIAL);
        }
        expect(unorderableLines(warn)[0]).toContain("outcome=refused-publish");
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("planning#495 — a blanked Claude credential holds nothing to protect", () => {
  let root: string;
  const sid = "session-blanked-credential";
  const BLANKED = fs.readFileSync(path.join(FIXTURE_DIR, "claude-blanked.json"), "utf-8");
  const LIVE = fs.readFileSync(fixturePath("claude"), "utf-8");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-blanked-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedPair(sourceContent: string, sessionContent: string): { src: string[]; dst: string[] } {
    const sessionDir = perSessionCredentialsDir(root, sid);
    const rels = AGENT_TOKEN_FILES.claude ?? [];
    const src: string[] = [];
    const dst: string[] = [];
    for (const rel of rels) {
      const s = path.join(root, rel);
      fs.mkdirSync(path.dirname(s), { recursive: true });
      fs.writeFileSync(s, sourceContent);
      src.push(s);
      const d = path.join(sessionDir, rel);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.writeFileSync(d, sessionContent);
      dst.push(d);
    }
    return { src, dst };
  }

  function unorderableLines(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls
      .map((call) => call.join(" "))
      .filter((line) => line.includes("token-freshness=unorderable"));
  }

  it("carries no expiry the reader can order — which is why it wedged", () => {
    const file = path.join(root, "blanked.json");
    fs.writeFileSync(file, BLANKED);
    expect(TOKEN_FRESHNESS.claude!(file)).toBeNull();
  });

  it("lets the sync-in replace a blanked session copy with the live source token", () => {
    const { dst } = seedPair(LIVE, BLANKED);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      syncAgentTokenIn(root, sid, "claude");
      for (const file of dst) expect(fs.readFileSync(file, "utf-8")).toBe(LIVE);
      expect(unorderableLines(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("publishes nothing from a blanked session copy, and says nothing about it", () => {
    const { src } = seedPair(LIVE, BLANKED);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      syncAgentTokenBack(root, sid, "claude");
      for (const file of src) expect(fs.readFileSync(file, "utf-8")).toBe(LIVE);
      expect(unorderableLines(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  // Without compare-and-swap, source repair could overwrite a concurrent sign-in.
  it("does not treat a blanked SOURCE as overwritable", () => {
    const { src } = seedPair(BLANKED, LIVE);
    expect(sessionTokenIsAheadOfSource(root, sid, "claude")).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      syncAgentTokenBack(root, sid, "claude");
      for (const file of src) expect(fs.readFileSync(file, "utf-8")).toBe(BLANKED);
      expect(unorderableLines(warn)[0]).toContain("outcome=refused-publish");
    } finally {
      warn.mockRestore();
    }
  });

  it("still refuses a credential that has a live token but an unreadable expiry", () => {
    const unreadableExpiry = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-STILL-LIVE gitleaks:allow",
        refreshToken: "sk-ant-ort01-STILL-LIVE gitleaks:allow",
        expiresAt: { seconds: 1787238459 },
      },
    });
    const { dst } = seedPair(LIVE, unreadableExpiry);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      syncAgentTokenIn(root, sid, "claude");
      for (const file of dst) expect(fs.readFileSync(file, "utf-8")).toBe(unreadableExpiry);
      expect(unorderableLines(warn)[0]).toContain("outcome=refused-copy");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not read a non-Claude shape as blanked", () => {
    expect(isBlankedClaudeCredential({ some_future_shape: { token: "opaque" } })).toBe(false);
    expect(isBlankedClaudeCredential({ claudeAiOauth: "not-an-object" })).toBe(false);
  });

  it("survives every non-object JSON its callers can hand it", () => {
    for (const value of [null, undefined, 42, "string", true, [], [{ claudeAiOauth: {} }]]) {
      expect(isBlankedClaudeCredential(value)).toBe(false);
    }
  });

  it.each([
    ["a live top-level access token", { accessToken: "sk-ant-oat01-LIVE gitleaks:allow" }],
    ["a live top-level snake_case alias", { access_token: "sk-ant-oat01-LIVE gitleaks:allow" }],
    ["a live top-level refresh token", { refreshToken: "sk-ant-ort01-LIVE gitleaks:allow" }],
  ])("is not fooled by %s beside a blanked oauth block", (_label, extra) => {
    expect(isBlankedClaudeCredential({
      ...extra,
      claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
    })).toBe(false);
  });

  it("is not fooled by an empty alias sitting beside a live one", () => {
    expect(isBlankedClaudeCredential({
      claudeAiOauth: {
        accessToken: "",
        access_token: "sk-ant-oat01-LIVE gitleaks:allow",
        refreshToken: "",
        expiresAt: 0,
      },
    })).toBe(false);
  });

  it("declares a blanked spawn home safe to delete without quarantining an empty file", () => {
    const spawnHome = path.join(root, "spawn-home");
    for (const rel of AGENT_TOKEN_FILES.claude ?? []) {
      const file = path.join(spawnHome, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, BLANKED);
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, LIVE);
    }
    expect(syncSubAgentSpawnHomeTokenBack(root, sid, spawnHome, "claude")).toBe(true);
    for (const rel of AGENT_TOKEN_FILES.claude ?? []) {
      expect(fs.readFileSync(path.join(root, rel), "utf-8")).toBe(LIVE);
    }
    expect(fs.existsSync(path.join(root, ".shipit-stranded-tokens"))).toBe(false);
  });
});
