/**
 * The injected fragment-scroll script (docs/258 req 9). A presented HTML
 * artifact is mounted from `srcDoc` on an opaque origin — there is no
 * `location.hash` to set and no channel to send one over — so the fragment is
 * baked into the document ShipIt assembles. That makes this the ONE place a
 * pointer's data enters such a document, and the only place it could break out.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { RenderedFrame } from "./RenderedFrame.js";

afterEach(cleanup);

function srcDoc(fragment: string | undefined, nonce = 1): string {
  cleanup();
  render(
    <RenderedFrame
      kind="html"
      content="<html><head></head><body><h1 id='a'>A</h1></body></html>"
      {...(fragment !== undefined ? { scrollTo: { fragment, nonce } } : {})}
    />,
  );
  return screen.getByTitle("Rendered content").getAttribute("srcdoc") ?? "";
}

describe("RenderedFrame — fragment scrolling", () => {
  it("injects nothing when no fragment was addressed", () => {
    expect(srcDoc(undefined)).not.toContain("scrollIntoView");
  });

  it("scrolls to the addressed element, deferred to DOMContentLoaded", () => {
    const html = srcDoc("req-7");
    expect(html).toContain('"req-7"');
    expect(html).toContain("scrollIntoView");
    // The click is what mounts the frame, so the element does not exist when
    // the script runs in <head> — firing on receipt would silently do nothing.
    expect(html).toContain("DOMContentLoaded");
  });

  it("changes with the nonce, so a repeat click re-scrolls", () => {
    // Identical `srcDoc` would not remount the frame, and clicks are
    // deliberately not coalesced.
    expect(srcDoc("req-7", 1)).not.toBe(srcDoc("req-7", 2));
  });

  it("keeps the CSP meta and lands the script inside <head>", () => {
    const html = srcDoc("req-7");
    expect(html).toContain("Content-Security-Policy");
    expect(html.indexOf("scrollIntoView")).toBeLessThan(html.indexOf("</head>"));
  });

  describe("a fragment cannot break out of the script", () => {
    it("escapes a closing script tag", () => {
      // `JSON.stringify` alone leaves this a valid JS string but still closes
      // the script element as far as the HTML parser is concerned.
      const html = srcDoc("x</script><img src=x onerror=alert(1)>");
      expect(html).not.toContain("</script><img");
      expect(html).toContain("\\u003c/script\\u003e");
    });

    it("escapes quotes and backslashes", () => {
      const html = srcDoc('a"b\\c');
      expect(html).toContain('\\"');
      expect(html).toContain("\\\\");
      // The `<script>` we opened is still closed exactly once.
      expect(html.match(/<\/script>/g)?.length).toBe(1);
    });

    it("escapes an HTML entity that would decode inside the script", () => {
      const html = srcDoc("a&lt;b");
      expect(html).toContain("\\u0026");
      expect(html).not.toContain("a&lt;b");
    });
  });

  it("ignores a fragment for SVG — there is no place inside one to address", () => {
    render(<RenderedFrame kind="svg" content="<svg/>" scrollTo={{ fragment: "x", nonce: 1 }} />);
    expect(screen.getByTitle("Rendered content").getAttribute("srcdoc"))
      .not.toContain("scrollIntoView");
  });
});
