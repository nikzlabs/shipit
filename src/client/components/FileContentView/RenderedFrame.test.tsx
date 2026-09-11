import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { RenderedFrame } from "./RenderedFrame.js";

afterEach(cleanup);

function srcDoc(fragment?: string): string {
  cleanup();
  render(
    <RenderedFrame
      kind="html"
      content="<html><head></head><body><h1 id='a'>A</h1></body></html>"
      {...(fragment !== undefined ? { scrollTo: fragment } : {})}
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
    expect(html).toContain("DOMContentLoaded");
  });

  it("remounts for a different fragment, and not for the same one", () => {
    expect(srcDoc("req-7")).not.toBe(srcDoc("req-9"));
    expect(srcDoc("req-7")).toBe(srcDoc("req-7"));
  });

  it("keeps the CSP meta and lands the script inside <head>", () => {
    const html = srcDoc("req-7");
    expect(html).toContain("Content-Security-Policy");
    expect(html.indexOf("scrollIntoView")).toBeLessThan(html.indexOf("</head>"));
  });

  describe("a fragment cannot break out of the script", () => {
    it("escapes a closing script tag", () => {
      const html = srcDoc("x</script><img src=x onerror=alert(1)>");
      expect(html).not.toContain("</script><img");
      expect(html).toContain("\\u003c/script\\u003e");
    });

    it("escapes quotes and backslashes", () => {
      const html = srcDoc('a"b\\c');
      expect(html).toContain('\\"');
      expect(html).toContain("\\\\");
      expect(html.match(/<\/script>/g)?.length).toBe(1);
    });

    it("escapes an HTML entity that would decode inside the script", () => {
      const html = srcDoc("a&lt;b");
      expect(html).toContain("\\u0026");
      expect(html).not.toContain("a&lt;b");
    });
  });

  it("ignores a fragment for SVG — there is no place inside one to address", () => {
    render(<RenderedFrame kind="svg" content="<svg/>" scrollTo="x" />);
    expect(screen.getByTitle("Rendered content").getAttribute("srcdoc"))
      .not.toContain("scrollIntoView");
  });

  describe("height reporting", () => {
    function srcDocFor(props: { kind: "html" | "svg"; reportHeight?: boolean }) {
      const { unmount } = render(
        <RenderedFrame kind={props.kind} content="<p>hi</p>" reportHeight={props.reportHeight} />,
      );
      const html = screen.getByTitle("Rendered content").getAttribute("srcdoc") ?? "";
      unmount();
      return html;
    }

    it("is off by default — the tab and the dialog size the frame themselves", () => {
      expect(srcDocFor({ kind: "html" })).not.toContain("content_height");
      expect(srcDocFor({ kind: "svg" })).not.toContain("content_height");
    });

    it("measures the BODY box, never documentElement.scrollHeight", () => {
      const html = srcDocFor({ kind: "html", reportHeight: true });
      expect(html).toContain("content_height");
      expect(html).toContain("document.body");
      expect(html).toContain("getBoundingClientRect");
      expect(html).not.toContain("document.documentElement.scrollHeight)");
    });

    it("drops the viewport-height SVG host, which would echo the frame back", () => {
      expect(srcDocFor({ kind: "svg", reportHeight: true })).not.toContain("100vh");
      expect(srcDocFor({ kind: "svg" })).toContain("100vh");
    });
  });
});
