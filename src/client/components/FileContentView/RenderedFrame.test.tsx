import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { LINK_CLICK_SCRIPT, RenderedFrame } from "./RenderedFrame.js";

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

  describe("ShipIt pointers inside an artifact (req 14)", () => {
    function srcDocFor(shipitLinks: boolean, kind: "html" | "svg" = "html") {
      cleanup();
      render(
        <RenderedFrame kind={kind} content="<html><head></head><body>x</body></html>" shipitLinks={shipitLinks} />,
      );
      return screen.getByTitle("Rendered content").getAttribute("srcdoc") ?? "";
    }

    it("is off by default — a repo file rendered in the dialog is not agent-authored", () => {
      expect(srcDocFor(false)).not.toContain("link_click");
    });

    it("injects the interceptor inside <head> when the surface opts in", () => {
      const html = srcDocFor(true);
      expect(html).toContain("link_click");
      expect(html.indexOf("link_click")).toBeLessThan(html.indexOf("</head>"));
      expect(html).toContain("Content-Security-Policy");
    });

    it("leaves SVG alone — only HTML and markdown artifacts carry pointers", () => {
      expect(srcDocFor(true, "svg")).not.toContain("link_click");
    });
  });

  /**
   * The interceptor runs inside a sandboxed frame jsdom never executes, so the
   * script is evaluated here against a real DOM. A string assertion could not
   * fail on a broken anchor walk or a scheme pattern that matches nothing.
   */
  describe("the injected interceptor, executed", () => {
    /**
     * A fresh document per case: the script installs document-level listeners,
     * and a shared one would let an earlier case's listener answer for a later
     * one's — which is how a repeat-count assertion stops meaning anything.
     */
    function mount(body: string) {
      const doc = document.implementation.createHTMLDocument("artifact");
      doc.body.innerHTML = body;
      const posted: unknown[] = [];
      const js = LINK_CLICK_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the very script shipped into the frame, against a document this test owns
      const run = new Function("document", "parent", js) as (d: Document, p: unknown) => void;
      run(doc, { postMessage: (msg: unknown) => posted.push(msg) });
      const fire = (type: "click" | "auxclick", button = 0) => {
        const target = doc.querySelector("[data-hit]") ?? doc.querySelector("a");
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
        target?.dispatchEvent(event);
        return event;
      };
      return { doc, posted, fire };
    }

    it("reports a preview pointer and stops the frame navigating to a scheme it cannot load", () => {
      const { posted, fire } = mount('<a href="shipit-preview://web/runs/1?focus=7#s">go</a>');
      const event = fire("click");
      expect(posted).toEqual([
        { source: "shipit-preview", type: "link_click", href: "shipit-preview://web/runs/1?focus=7#s" },
      ]);
      expect(event.defaultPrevented).toBe(true);
    });

    it("reports a click on an element nested inside the anchor", () => {
      const { posted, fire } = mount(
        '<a href="shipit-present:/persist/r.html#req-7"><span data-hit>REQ-7</span></a>',
      );
      fire("click");
      expect(posted).toHaveLength(1);
    });

    it("leaves the artifact's own links completely alone", () => {
      for (const href of ["https://example.com", "#section", "/local/path"]) {
        const { posted, fire } = mount(`<a href="${href}">x</a>`);
        const event = fire("click");
        expect(posted, href).toEqual([]);
        expect(event.defaultPrevented, href).toBe(false);
      }
    });

    it("blocks a middle-click without opening it — a custom scheme must not reach the OS handler", () => {
      const { posted, fire } = mount('<a href="shipit-preview://web/x">go</a>');
      const event = fire("auxclick", 1);
      expect(event.defaultPrevented).toBe(true);
      expect(posted).toEqual([]);
    });

    it("survives a page that stops propagation on its own links", () => {
      const { doc, posted, fire } = mount('<a href="shipit-preview://web/x">go</a>');
      doc.querySelector("a")?.addEventListener("click", (e) => e.stopPropagation());
      fire("click");
      expect(posted).toHaveLength(1);
    });
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
