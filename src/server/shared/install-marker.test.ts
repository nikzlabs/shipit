/**
 * Unit tests for the stamped install marker (docs/183 Phase 3, docs/197 Part 1).
 *
 * The gate's correctness rests on `parseMarker` rejecting anything that isn't an
 * exact, current-version stamp, and `markerMatches` demanding runtime + commands
 * agree AND (commit matches OR depsHash matches). These cover the legacy/corrupt
 * rejection path, each field's mismatch, and the content-key OR widening — incl.
 * the invariant that a `null` depsHash can only ever cause a reinstall.
 */
import { describe, it, expect } from "vitest";
import {
  INSTALL_MARKER_VERSION,
  makeMarker,
  markerMatches,
  parseMarker,
  serializeMarker,
  type InstallMarkerStamp,
} from "./install-marker.js";

const STAMP: InstallMarkerStamp = {
  sourceCommit: "a".repeat(40),
  runtimeKey: "img|x64|glibc-2.39|node22",
  installCommands: ["npm ci"],
  depsHash: "deadbeef".repeat(8),
};

describe("install-marker — round-trip", () => {
  it("serialize → parse preserves every stamped field", () => {
    const marker = makeMarker(STAMP, "2026-06-09T00:00:00.000Z");
    const parsed = parseMarker(serializeMarker(marker));
    expect(parsed).toEqual(marker);
    expect(parsed?.version).toBe(INSTALL_MARKER_VERSION);
    expect(parsed?.depsHash).toBe(STAMP.depsHash);
  });

  it("round-trips a null sourceCommit (non-git workspace)", () => {
    const marker = makeMarker({ ...STAMP, sourceCommit: null }, "2026-06-09T00:00:00.000Z");
    const parsed = parseMarker(serializeMarker(marker));
    expect(parsed?.sourceCommit).toBeNull();
  });

  it("round-trips a null depsHash (content-keying off)", () => {
    const marker = makeMarker({ ...STAMP, depsHash: null }, "2026-06-09T00:00:00.000Z");
    const parsed = parseMarker(serializeMarker(marker));
    expect(parsed?.depsHash).toBeNull();
  });
});

describe("install-marker — parse rejection (skip-miss)", () => {
  it("rejects a legacy bare-timestamp marker", () => {
    expect(parseMarker("2026-06-09T00:00:00.000Z")).toBeNull();
  });

  it("rejects corrupt / truncated JSON", () => {
    expect(parseMarker('{"version":2,')).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(parseMarker("42")).toBeNull();
    expect(parseMarker('"hi"')).toBeNull();
    expect(parseMarker("null")).toBeNull();
  });

  it("rejects a legacy v1 marker (no depsHash) so the version bump misses cleanly", () => {
    // A pre-docs/197 marker: version 1, every other field valid, no depsHash.
    const v1 = JSON.stringify({
      version: 1,
      sourceCommit: STAMP.sourceCommit,
      runtimeKey: STAMP.runtimeKey,
      installCommands: STAMP.installCommands,
      completedAt: "t",
    });
    expect(parseMarker(v1)).toBeNull();
  });

  it("rejects a future schema version", () => {
    const raw = JSON.stringify({ ...makeMarker(STAMP, "t"), version: 3 });
    expect(parseMarker(raw)).toBeNull();
  });

  it("rejects missing / wrong-typed fields", () => {
    const base = makeMarker(STAMP, "t");
    expect(parseMarker(JSON.stringify({ ...base, runtimeKey: 123 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, installCommands: "npm ci" }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, installCommands: [1, 2] }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, sourceCommit: 7 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, depsHash: 7 }))).toBeNull();
    const { completedAt: _omit, ...noCompletedAt } = base;
    expect(parseMarker(JSON.stringify(noCompletedAt))).toBeNull();
    const { depsHash: _omitHash, ...noDepsHash } = base;
    expect(parseMarker(JSON.stringify(noDepsHash))).toBeNull();
  });
});

describe("install-marker — matching (commit path)", () => {
  const marker = makeMarker(STAMP, "t");

  it("matches an identical stamp", () => {
    expect(markerMatches(marker, STAMP)).toBe(true);
  });

  it("matches when both source commits are null and the hash is too", () => {
    const nullMarker = makeMarker({ ...STAMP, sourceCommit: null, depsHash: null }, "t");
    expect(markerMatches(nullMarker, { ...STAMP, sourceCommit: null, depsHash: null })).toBe(true);
  });

  it("mismatches on a different runtime fingerprint regardless of commit/hash", () => {
    expect(markerMatches(marker, { ...STAMP, runtimeKey: "img|arm64|musl|node22" })).toBe(false);
  });

  it("mismatches on a changed install command regardless of commit/hash", () => {
    expect(markerMatches(marker, { ...STAMP, installCommands: ["npm install"] })).toBe(false);
  });

  it("mismatches on command count and order", () => {
    expect(markerMatches(marker, { ...STAMP, installCommands: ["npm ci", "npm run build"] })).toBe(false);
    const two = makeMarker({ ...STAMP, installCommands: ["a", "b"], depsHash: null }, "t");
    expect(markerMatches(two, { ...STAMP, installCommands: ["b", "a"], depsHash: null })).toBe(false);
  });

  it("mismatches on a different source commit when the content key cannot rescue it", () => {
    // depsHash null on both → only the commit path is available, and it differs.
    const noHash = makeMarker({ ...STAMP, depsHash: null }, "t");
    expect(markerMatches(noHash, { ...STAMP, sourceCommit: "b".repeat(40), depsHash: null })).toBe(false);
  });
});

describe("install-marker — matching (content-key OR path, docs/197)", () => {
  const marker = makeMarker(STAMP, "t");

  it("skips a DIFFERENT commit when the dep-file hash matches (the whole point)", () => {
    // runtime + commands agree, commit differs, but the dep files hash the same.
    expect(markerMatches(marker, { ...STAMP, sourceCommit: "b".repeat(40) })).toBe(true);
  });

  it("does NOT skip when neither the commit nor the hash matches", () => {
    expect(
      markerMatches(marker, { ...STAMP, sourceCommit: "b".repeat(40), depsHash: "f".repeat(64) }),
    ).toBe(false);
  });

  it("a null current hash never matches via the content path (reinstall, never wrong skip)", () => {
    // Marker has a hash, current does not (codegen install / no inputs). Commit
    // differs, so there is no commit-path rescue → miss.
    expect(markerMatches(marker, { ...STAMP, sourceCommit: "b".repeat(40), depsHash: null })).toBe(false);
  });

  it("a null marker hash never matches via the content path", () => {
    const noHash = makeMarker({ ...STAMP, depsHash: null }, "t");
    expect(markerMatches(noHash, { ...STAMP, sourceCommit: "b".repeat(40) })).toBe(false);
  });

  it("still matches via the commit path even when the hash differs", () => {
    // Same commit, different hash (shouldn't happen in practice, but the commit
    // path is independent and sufficient).
    expect(markerMatches(marker, { ...STAMP, depsHash: "f".repeat(64) })).toBe(true);
  });
});
