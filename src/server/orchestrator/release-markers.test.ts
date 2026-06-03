import { describe, it, expect } from "vitest";
import { parseReleaseMarkers } from "./release-markers.js";

describe("parseReleaseMarkers", () => {
  it("returns nothing when there is no marker", () => {
    expect(parseReleaseMarkers("just some normal text")).toEqual([]);
    expect(parseReleaseMarkers("")).toEqual([]);
  });

  it("parses a propose marker with all fields", () => {
    const text = `I'll cut the release.
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: x\\n- Fix: y"}-->`;
    expect(parseReleaseMarkers(text)).toEqual([
      {
        action: "propose",
        version: "0.3.0",
        tag: "v0.3.0",
        prerelease: false,
        bumpType: "minor",
        notes: "- Feature: x\n- Fix: y",
      },
    ]);
  });

  it("parses a tagged marker with the commit sha", () => {
    const text = `<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"abc123"}-->`;
    expect(parseReleaseMarkers(text)).toEqual([
      { action: "tagged", tag: "v0.3.0", version: "0.3.0", sha: "abc123" },
    ]);
  });

  it("parses already-released and cancelled markers", () => {
    expect(parseReleaseMarkers(`<!--shipit:release {"action":"already-released","tag":"v1.0.0"}-->`)).toEqual([
      { action: "already-released", tag: "v1.0.0" },
    ]);
    expect(parseReleaseMarkers(`<!--shipit:release {"action":"cancelled"}-->`)).toEqual([
      { action: "cancelled" },
    ]);
  });

  it("ignores a propose marker missing required fields", () => {
    expect(parseReleaseMarkers(`<!--shipit:release {"action":"propose","version":"0.3.0"}-->`)).toEqual([]);
    expect(parseReleaseMarkers(`<!--shipit:release {"action":"tagged"}-->`)).toEqual([]);
  });

  it("skips malformed JSON and unknown actions", () => {
    expect(parseReleaseMarkers(`<!--shipit:release {not json}-->`)).toEqual([]);
    expect(parseReleaseMarkers(`<!--shipit:release {"action":"explode","tag":"v1"}-->`)).toEqual([]);
  });

  it("parses multiple markers in document order", () => {
    const text = `
<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","prerelease":false}-->
later...
<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"deadbeef"}-->`;
    const markers = parseReleaseMarkers(text);
    expect(markers.map((m) => m.action)).toEqual(["propose", "tagged"]);
  });

  it("ignores an unknown bumpType but keeps the proposal", () => {
    const text = `<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","bumpType":"weird"}-->`;
    expect(parseReleaseMarkers(text)).toEqual([
      { action: "propose", version: "0.3.0", tag: "v0.3.0", prerelease: false },
    ]);
  });
});
