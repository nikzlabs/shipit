import { describe, expect, it } from "vitest";
import { getLoadedClientBuildId, shouldReloadForServerBuild } from "./client-build.js";

describe("client build utilities", () => {
  it("fingerprints the loaded Vite assets", () => {
    document.head.innerHTML = `
      <link rel="stylesheet" href="/assets/index-BBB.css">
      <script type="module" src="/assets/index-AAA.js"></script>
    `;

    expect(getLoadedClientBuildId(document)).toBe("/assets/index-AAA.js|/assets/index-BBB.css");
  });

  it("reloads only when both build ids exist and differ", () => {
    expect(shouldReloadForServerBuild("/assets/old.js", "/assets/new.js")).toBe(true);
    expect(shouldReloadForServerBuild("/assets/new.js", "/assets/new.js")).toBe(false);
    expect(shouldReloadForServerBuild(undefined, "/assets/new.js")).toBe(false);
    expect(shouldReloadForServerBuild("/assets/old.js", undefined)).toBe(false);
  });
});
