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
  syncAgentTokenIn,
  syncAgentTokenBack,
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
