import { describe, it, expect } from "vitest";
import { parseReleaseMarkers } from "./release-markers.js";

describe("parseReleaseMarkers", () => {
  it("returns nothing when there is no marker", () => {
    expect(parseReleaseMarkers("just some normal text")).toEqual([]);
    expect(parseReleaseMarkers("")).toEqual([]);
  });

  it("parses a propose marker with all fields", () => {
    const text = `I'll cut the release.
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"versionSource":"package.json"}-->`;
    expect(parseReleaseMarkers(text)).toEqual([
      {
        action: "propose",
        version: "0.3.0",
        tag: "v0.3.0",
        prerelease: false,
        bumpType: "minor",
        versionSource: "package.json",
      },
    ]);
  });

  // docs/309 req 11: the card shows what would be published, which the agent
  // cannot restate — so a notes field is dropped wherever it is written.
  it("drops a notes field from every marker", () => {
    const text = `<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","prerelease":false,"notes":"- invented"}-->
<!--shipit:release {"action":"pr-opened","version":"0.3.0","tag":"v0.3.0","prNumber":7,"prUrl":"https://x/7","releaseBranch":"stable","notes":"- invented"}-->
<!--shipit:release {"action":"tagged","tag":"v0.3.0","notes":"- invented"}-->`;
    const markers = parseReleaseMarkers(text);
    expect(markers).toHaveLength(3);
    for (const marker of markers) expect(marker).not.toHaveProperty("notes");
  });

  it("parses a propose marker's mechanism when valid, drops it when not (docs/214)", () => {
    const valid = `<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","prerelease":false,"mechanism":"release-branch"}-->`;
    expect(parseReleaseMarkers(valid)).toEqual([
      { action: "propose", version: "0.3.0", tag: "v0.3.0", prerelease: false, mechanism: "release-branch" },
    ]);

    const bogus = `<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","prerelease":false,"mechanism":"nonsense"}-->`;
    expect(parseReleaseMarkers(bogus)).toEqual([
      { action: "propose", version: "0.3.0", tag: "v0.3.0", prerelease: false },
    ]);
  });

  it("parses a tagged marker with the commit sha", () => {
    const text = `<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"abc123"}-->`;
    expect(parseReleaseMarkers(text)).toEqual([
      { action: "tagged", tag: "v0.3.0", version: "0.3.0", sha: "abc123" },
    ]);
  });

  it("parses a pr-opened marker with all fields (docs/214)", () => {
    const text = `<!--shipit:release {"action":"pr-opened","version":"0.3.0","tag":"v0.3.0","prNumber":42,"prUrl":"https://github.com/o/r/pull/42","releaseBranch":"stable","bumpType":"minor","versionSource":"package.json"}-->`;
    expect(parseReleaseMarkers(text)).toEqual([
      {
        action: "pr-opened",
        version: "0.3.0",
        tag: "v0.3.0",
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
        releaseBranch: "stable",
        bumpType: "minor",
        versionSource: "package.json",
      },
    ]);
  });

  it("ignores a pr-opened marker missing required fields", () => {
    expect(
      parseReleaseMarkers(`<!--shipit:release {"action":"pr-opened","version":"0.3.0","tag":"v0.3.0"}-->`),
    ).toEqual([]);
    expect(
      parseReleaseMarkers(
        `<!--shipit:release {"action":"pr-opened","version":"0.3.0","tag":"v0.3.0","prNumber":0,"prUrl":"x","releaseBranch":"stable"}-->`,
      ),
    ).toEqual([]);
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
