/**
 * Unit tests for the stamped install marker (docs/183 Phase 3).
 *
 * The gate's correctness rests entirely on `parseMarker` rejecting anything
 * that isn't an exact, current-version stamp and `markerMatches` demanding all
 * three fields agree — so these cover the legacy/corrupt rejection path and each
 * field's mismatch independently.
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
};

describe("install-marker — round-trip", () => {
  it("serialize → parse preserves every stamped field", () => {
    const marker = makeMarker(STAMP, "2026-06-09T00:00:00.000Z");
    const parsed = parseMarker(serializeMarker(marker));
    expect(parsed).toEqual(marker);
    expect(parsed?.version).toBe(INSTALL_MARKER_VERSION);
  });

  it("round-trips a null sourceCommit (non-git workspace)", () => {
    const marker = makeMarker({ ...STAMP, sourceCommit: null }, "2026-06-09T00:00:00.000Z");
    const parsed = parseMarker(serializeMarker(marker));
    expect(parsed?.sourceCommit).toBeNull();
  });
});

describe("install-marker — parse rejection (skip-miss)", () => {
  it("rejects a legacy bare-timestamp marker", () => {
    expect(parseMarker("2026-06-09T00:00:00.000Z")).toBeNull();
  });

  it("rejects corrupt / truncated JSON", () => {
    expect(parseMarker('{"version":1,')).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(parseMarker("42")).toBeNull();
    expect(parseMarker('"hi"')).toBeNull();
    expect(parseMarker("null")).toBeNull();
  });

  it("rejects a future schema version", () => {
    const raw = JSON.stringify({ ...makeMarker(STAMP, "t"), version: 2 });
    expect(parseMarker(raw)).toBeNull();
  });

  it("rejects missing / wrong-typed fields", () => {
    const base = makeMarker(STAMP, "t");
    expect(parseMarker(JSON.stringify({ ...base, runtimeKey: 123 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, installCommands: "npm ci" }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, installCommands: [1, 2] }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...base, sourceCommit: 7 }))).toBeNull();
    const { completedAt: _omit, ...noCompletedAt } = base;
    expect(parseMarker(JSON.stringify(noCompletedAt))).toBeNull();
  });
});

describe("install-marker — matching", () => {
  const marker = makeMarker(STAMP, "t");

  it("matches an identical stamp", () => {
    expect(markerMatches(marker, STAMP)).toBe(true);
  });

  it("matches when both source commits are null", () => {
    const nullMarker = makeMarker({ ...STAMP, sourceCommit: null }, "t");
    expect(markerMatches(nullMarker, { ...STAMP, sourceCommit: null })).toBe(true);
  });

  it("mismatches on a different source commit", () => {
    expect(markerMatches(marker, { ...STAMP, sourceCommit: "b".repeat(40) })).toBe(false);
  });

  it("mismatches null vs a real commit (either direction)", () => {
    expect(markerMatches(marker, { ...STAMP, sourceCommit: null })).toBe(false);
    const nullMarker = makeMarker({ ...STAMP, sourceCommit: null }, "t");
    expect(markerMatches(nullMarker, STAMP)).toBe(false);
  });

  it("mismatches on a different runtime fingerprint", () => {
    expect(markerMatches(marker, { ...STAMP, runtimeKey: "img|arm64|musl|node22" })).toBe(false);
  });

  it("mismatches on a changed install command", () => {
    expect(markerMatches(marker, { ...STAMP, installCommands: ["npm install"] })).toBe(false);
  });

  it("mismatches on command count and order", () => {
    expect(markerMatches(marker, { ...STAMP, installCommands: ["npm ci", "npm run build"] })).toBe(false);
    const two = makeMarker({ ...STAMP, installCommands: ["a", "b"] }, "t");
    expect(markerMatches(two, { ...STAMP, installCommands: ["b", "a"] })).toBe(false);
  });
});
