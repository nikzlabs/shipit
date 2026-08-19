import { describe, it, expect } from "vitest";
import {
  markerClaimsOwnership,
  pluginSkillLabel,
  PLUGIN_SKILL_MARKER_ID,
} from "./plugin-skill-marker.js";

describe("markerClaimsOwnership", () => {
  it("accepts only the exact marker id", () => {
    expect(markerClaimsOwnership(JSON.stringify({ marker: PLUGIN_SKILL_MARKER_ID }))).toBe(true);
    expect(markerClaimsOwnership(JSON.stringify({ marker: "shipit-plugin-skill-v0" }))).toBe(false);
    expect(markerClaimsOwnership(JSON.stringify({ name: "probe" }))).toBe(false);
  });

  it("treats anything unparseable or non-object as not ours", () => {
    expect(markerClaimsOwnership("not json")).toBe(false);
    expect(markerClaimsOwnership("null")).toBe(false);
    expect(markerClaimsOwnership(`"${PLUGIN_SKILL_MARKER_ID}"`)).toBe(false);
    expect(markerClaimsOwnership("")).toBe(false);
  });
});

describe("pluginSkillLabel", () => {
  it("renders a materialized name as <alias>/<skill>", () => {
    expect(pluginSkillLabel("plugins--assetgen--assetgen-aab26884689f")).toBe("assetgen/assetgen");
    expect(pluginSkillLabel("plugins--design-docs--design-docs-5d17d9cba58c")).toBe(
      "design-docs/design-docs",
    );
  });

  it("returns null for anything that is not one of ours", () => {
    // A user's or marketplace skill: no hash suffix, or no alias/skill split.
    expect(pluginSkillLabel("commit")).toBeNull();
    expect(pluginSkillLabel("plugins--acme__probe")).toBeNull();
    expect(pluginSkillLabel("plugins--assetgen--assetgen")).toBeNull();
    expect(pluginSkillLabel("plugins--assetgen--assetgen-NOTHEX12345")).toBeNull();
  });
});
