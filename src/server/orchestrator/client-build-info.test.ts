import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildClientAssetFingerprint, getServedClientBuildId } from "./client-build-info.js";

describe("client build info", () => {
  it("fingerprints Vite asset references from index.html", () => {
    const html = `
      <link rel="stylesheet" crossorigin href="/assets/index-BBB.css">
      <script type="module" crossorigin src="/assets/index-AAA.js"></script>
    `;

    expect(buildClientAssetFingerprint(html)).toBe("/assets/index-AAA.js|/assets/index-BBB.css");
  });

  it("returns undefined when no built assets are present", () => {
    expect(buildClientAssetFingerprint("<div>No bundle here</div>")).toBeUndefined();
  });

  it("reads the served client fingerprint from dist index.html", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipit-client-build-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      '<script type="module" src="/assets/index-123.js"></script>',
      "utf8",
    );

    await expect(getServedClientBuildId(dir)).resolves.toBe("/assets/index-123.js");
  });
});
