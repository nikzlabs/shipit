// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://11111111-1111-1111-1111-111111111111--3000.shipit--443.example.com:8080/app" }

/**
 * The sibling origin is this page's own host with the **preview** port segment
 * replaced. A looser `.*--(\d+)\.` matches greedily, so a deployment host that
 * itself contains `--<digits>.` would have *its* label rewritten instead — and
 * the origin check cannot catch that, because it compares the result against
 * the same wrongly built origin.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { EMBED_RESOLVER_SOURCE } from "./bootstrap.js";

describe("deriving the sibling origin", () => {
  beforeEach(() => {
    const root = document.createElement("html");
    root.appendChild(document.createElement("head"));
    root.appendChild(document.createElement("body"));
    document.replaceChild(root, document.documentElement);

    const script = document.createElement("script");
    script.setAttribute("data-shipit-services", JSON.stringify({ assetgen: 5173 }));
    script.textContent = EMBED_RESOLVER_SOURCE;
    document.head.appendChild(script);
  });

  it("replaces the preview label and leaves a deployment label alone", async () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("src", "shipit-preview://assetgen/e.html");
    document.body.appendChild(frame);
    await Promise.resolve();
    await Promise.resolve();

    expect(frame.getAttribute("src")).toBe(
      "http://11111111-1111-1111-1111-111111111111--5173.shipit--443.example.com:8080/e.html",
    );
  });
});
