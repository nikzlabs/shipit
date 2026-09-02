/**
 * planning#449 — every declared freshness reader, against a REAL credential file.
 *
 * A freshness reader is invisible when it breaks. It returns `null`, and the
 * only place that answer surfaces is a copy decision inside
 * `token-sync-manager.ts` that used to read it as "nothing here worth keeping"
 * and overwrite the session's own token. Grok's first reader did exactly that
 * on every real file — it accepted only a numeric `expires_at`, while the CLI
 * writes an ISO-8601 string — and a unit test built from the DESCRIBED shape
 * would have passed while the live file failed.
 *
 * So this file tests the readers against captured files rather than against
 * their own assumptions, and its provenance matters more than its assertions:
 *
 *   - **`claude.json`** — captured 2026-08-20 from a live
 *     `~/.claude/.credentials.json` inside a ShipIt session container. Field
 *     set, ordering and non-secret values (`scopes`, `subscriptionType`,
 *     `rateLimitTier`, both epoch-ms expiries) verbatim; the two token strings
 *     replaced with same-prefix placeholders.
 *   - **`grok.json`** — captured 2026-08-19 from a live
 *     `grok login --device-auth` (planning#435). Verbatim including the
 *     unguessable `https://auth.x.ai::<client-uuid>` scope key, the access
 *     token under `key`, and the ISO-8601 `expires_at`; secrets replaced. Same
 *     capture as the fixture in `agents/grok/auth-manager.test.ts`.
 *   - **`codex.json`** — NOT a fresh capture, and the weakest of the three: no
 *     Codex credential was reachable from the container this was written in. It
 *     is reconstructed from in-repo evidence of real files — the `last_refresh`
 *     + `tokens.access_token` JWT `exp` dump recorded in
 *     `docs/154-codex-oauth-refresh-readiness/plan.md`, and the
 *     `tokens.{id_token,access_token}` / `https://api.openai.com/auth` claim
 *     shape `agents/codex/auth-manager.ts` reads. It therefore guards against a
 *     reader REGRESSION but cannot prove the shape is current. Re-capture it
 *     from a live `~/.codex/auth.json` when one is at hand.
 *
 * The rule the recipe now states (docs/266-harness-integration-recipe): a new
 * harness's fixture is a real captured file, not a documented shape.
 *
 * Two deviations from "verbatim", both forced and both harmless to the readers:
 * every secret is a placeholder, and each placeholder line carries the
 * `gitleaks:allow` marker (docs/213) — a real `sk-ant-` prefix and a real JWT
 * shape are exactly what the secret scanner blocks, and JSON has no comments,
 * so the marker has to ride inside the string. It sits in the JWT's SIGNATURE
 * segment, which no reader parses; the header and payload segments the `exp`
 * claim is read from are untouched.
 */
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

/** A structurally valid credential carrying no signal any reader knows. */
const ALIEN_CREDENTIAL = JSON.stringify({ some_future_shape: { token: "opaque" } });

/** The marker only ever appears in the SOURCE copy, so a copy is observable. */
const SOURCE_MARKER = "__shipit_fixture_source_marker";

function fixturePath(agentId: AgentId): string {
  return path.join(FIXTURE_DIR, `${agentId}.json`);
}

/** The captured file, plus a top-level key no reader looks at, so a copy shows. */
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

  /** Seed the flat-root source and the session copy for one agent. */
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

  /**
   * The parity half: a harness reaches the sync path by appearing in
   * {@link AGENT_TOKEN_FILES}, and without a reader its guard degrades to
   * `() => null` — every compare unprovable, every session's rotation
   * clobberable. The compiler cannot catch it; `Partial<Record<…>>` is what
   * makes both tables optional.
   */
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

    /**
     * The assertion the whole file exists for: a reader that has stopped
     * matching what its CLI writes returns null here, and null is what every
     * silent failure in this subsystem looks like.
     */
    it("orders the real captured credential file", () => {
      const at = read(fixturePath(agentId));
      expect(at, `${agentId}'s freshness reader returned null for its real file`).not.toBeNull();
      expect(Number.isFinite(at!)).toBe(true);
      expect(at!).toBeGreaterThan(0);
    });

    /**
     * End to end, and the reason the direct assertion above is not enough: the
     * guards must be able to ORDER the real shape, not merely parse it. Both
     * copies hold the same captured file, so a working reader compares them and
     * says nothing; a broken one cannot tell them apart and says so.
     */
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

    /**
     * The defect itself: a session credential the reader cannot order is a
     * reader that stopped working, not a session with nothing to lose. Copying
     * over it destroys a token the CLI may have just rotated — and the rotating
     * refresh token it replaces is already spent upstream.
     */
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

    /**
     * …and the direction that must NOT change (docs/142 A). A file that is not
     * a credential at all — half-written, emptied, never seeded — has nothing
     * to protect, so the copy still runs. Refusing here would strand a session
     * with no way back to a working token.
     */
    it("still copies over a session file that is not a credential", () => {
      const sessionFiles = seed(agentId, "not json at all");
      syncAgentTokenIn(root, sid, agentId);
      for (const file of sessionFiles) {
        expect(fs.readFileSync(file, "utf-8")).toContain(SOURCE_MARKER);
      }
    });

    /**
     * The publish direction fails safe on its own (an unprovable session token
     * is never published), but a SOURCE the reader cannot order is the same
     * hazard aimed at every session at once: the refresher writes that file
     * too, so overwriting it can bury the live credential the whole install
     * shares.
     */
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

/**
 * planning#495 — the BLANKED Claude credential, and the wedge it caused.
 *
 * Observed in production 2026-09-02 on one session: a `refused-copy` at
 * 09:06:11 and a `stranded-rotation` at 09:06:13, both naming the same
 * `.claude/.credentials.json`, two minutes after that session's CLI 401'd. The
 * 401 is the ordinary consequence of a sibling rotating the shared account's
 * single-use refresh token first; what the CLI does next is rewrite its own copy
 * with the tokens emptied and `expiresAt: 0` — the shape docs/153 already names
 * `blanked` in the refresher's `missing_credentials` diagnosis.
 *
 * `expiresAt: 0` fails the reader's `> 0` test, so the file read as null; it
 * still parsed as a credential, so it read as `unorderable`; and `unorderable`
 * refuses the overwrite in BOTH directions by design (planning#449). The session
 * was therefore pinned to an empty credential that the account's live token was
 * forbidden to replace — permanently, since every ordinary path back runs
 * through the sync-in that just refused.
 *
 * The fixture is the shape as `describeUnusableSource` documents it, with no
 * secret to redact: both token fields are empty strings, which is the whole
 * point of it.
 */
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

  /** Write one content into the flat source and another into the session copy. */
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

  /**
   * The incident, inverted: the account's live token now reaches the session on
   * its very next turn, and no `refused-copy` line is printed. Without the
   * blank probe this copy is refused and the session never authenticates again.
   */
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

  /**
   * The other half of the same wedge: the turn-end publish no longer reports a
   * stranded rotation for a file that carries no rotation. It still publishes
   * nothing — an empty credential must never reach the account root.
   */
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

  /**
   * The scope line, and the half of this that must NOT move. docs/153 weighed
   * repairing a blanked ACCOUNT root so a session's rotation could be harvested
   * over it, and rejected it: there is no compare-and-swap, so a repair losing a
   * race with a completing sign-in destroys a live credential. The probe is
   * therefore applied to a session's `replica` and never to a `source` — a
   * blanked account root stays `unorderable`, the harvest still declines, and
   * that human decision is left where it was.
   */
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

  /**
   * The boundary that must NOT move. planning#449 is about a reader that stopped
   * matching its CLI, and such a file still holds a live bearer — emptiness is
   * judged on the TOKENS, never on the expiry alone. A credential with a real
   * access token and an expiry shape this reader cannot parse stays
   * `unorderable` and stays protected.
   */
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

  /**
   * The predicate's callers hand it whatever `JSON.parse` returned, and
   * `JSON.parse("null")` is a valid parse. In the refresher it is called OUTSIDE
   * the parse `try`, so a throw there is an unhandled error on a scheduled tick
   * — the account never reaches its `missing_credentials` state and the
   * schedule does not re-arm.
   */
  it("survives every non-object JSON its callers can hand it", () => {
    for (const value of [null, undefined, 42, "string", true, [], [{ claudeAiOauth: {} }]]) {
      expect(isBlankedClaudeCredential(value)).toBe(false);
    }
  });

  /**
   * Claude's schema has varied across CLI versions: `extractAccessToken`
   * (`agents/claude/auth-manager.ts`) probes both aliases at the top level as
   * well as inside `claudeAiOauth`, taking the first non-empty hit. Any
   * non-empty token in any of those places is a bearer this probe must not
   * declare missing — a wrongly-declared blank licenses an overwrite, and on
   * the spawn-home and borrow cleanup paths it skips the quarantine before the
   * caller deletes the only copy.
   *
   * The `""`-beside-a-live-alias case is the one an `a ?? b` gets wrong: the
   * empty string is not nullish, so it short-circuits to the empty side.
   */
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

  /**
   * The cleanup paths are where a wrong `absent` costs a rotation outright:
   * `syncSubAgentSpawnHomeTokenBack` returns "safe to delete" and the caller
   * removes the only copy. A genuinely blanked spawn home is safe to drop —
   * there is nothing in it — but it must be for the right reason, so this pins
   * that the return is true and no quarantine artifact was written.
   */
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
