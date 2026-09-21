// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://11111111-1111-1111-1111-111111111111--3000.localhost:8080/app" }

import { describe, expect, it, beforeEach } from "vitest";
import { EMBED_RESOLVER_SOURCE, buildEmbedResolverScript } from "./bootstrap.js";

const SIBLING = "http://11111111-1111-1111-1111-111111111111--5173.localhost:8080";

function install(ports: Record<string, number> = { assetgen: 5173, web: 3000 }): void {
  const script = document.createElement("script");
  script.setAttribute("data-shipit-services", JSON.stringify(ports));
  script.textContent = EMBED_RESOLVER_SOURCE;
  document.head.appendChild(script);
}

function addIframe(src: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("src", src);
  document.body.appendChild(frame);
  return frame;
}

/** MutationObserver callbacks are microtasks, so a rewrite lands a tick later. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("preview embed resolver", () => {
  // A fresh root per test: clearing head and body would leave the previous
  // test's MutationObserver attached to the old documentElement, so its map
  // would keep resolving names this test never declared.
  beforeEach(() => {
    const root = document.createElement("html");
    root.appendChild(document.createElement("head"));
    root.appendChild(document.createElement("body"));
    document.replaceChild(root, document.documentElement);
  });

  it("resolves a service name to the sibling preview origin", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/embed.html?id=char%2Fminer%231&angle=front");
    await settle();

    expect(frame.getAttribute("src")).toBe(
      `${SIBLING}/embed.html?id=char%2Fminer%231&angle=front`,
    );
    expect(frame.getAttribute("data-shipit-service")).toBe("assetgen");
  });

  it("rewrites an iframe already in the document when the script runs", async () => {
    const frame = addIframe("shipit-preview://assetgen/embed.html");
    install();
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/embed.html`);
  });

  it("rewrites an src assigned after the element was inserted", async () => {
    install();
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    await settle();
    frame.setAttribute("src", "shipit-preview://assetgen/");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/`);
  });

  it("addresses the service root when the address carries no path", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/`);
  });

  it("keeps a query that carries no path", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen?view=front#top");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/?view=front#top`);
  });

  it("strips ShipIt's own render parameter and keeps the rest byte-for-byte", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e.html?shipit-render=button&q=a%7Eb");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/e.html?q=a%7Eb`);
  });

  it("drops the question mark when the render parameter was the whole query", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e.html?shipit-render=badge#req-7");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/e.html#req-7`);
  });

  // The two sides must behave alike: reading `indexOf("?")` across the whole
  // address found the fragment's `?` only when no query stood before it, so the
  // same address was stripped or kept depending on its neighbour.
  it("strips the render parameter from the fragment too", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e.html?x=1#route?shipit-render=button");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/e.html?x=1#route`);
  });

  it("leaves a hash router's own query untouched", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e.html#/items?focus=7");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/e.html#/items?focus=7`);
  });

  // A network-path reference carries its own authority, so the origin check
  // alone would pass a credential-bearing URL at the sibling's own host.
  it("refuses a path that smuggles credentials at the sibling host", async () => {
    install();
    const href = "shipit-preview://assetgen//u:p@11111111-1111-1111-1111-111111111111--5173.localhost:8080/x";
    const frame = addIframe(href);
    await settle();

    expect(frame.getAttribute("src")).toBe(href);
  });

  it("leaves an undeclared service name alone", async () => {
    install();
    const frame = addIframe("shipit-preview://nope/e.html");
    await settle();

    expect(frame.getAttribute("src")).toBe("shipit-preview://nope/e.html");
  });

  it("leaves a service declared without a port alone", async () => {
    install({ web: 3000 });
    const frame = addIframe("shipit-preview://assetgen/e.html");
    await settle();

    expect(frame.getAttribute("src")).toBe("shipit-preview://assetgen/e.html");
  });

  it("matches the service name exactly, never as a prefix", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen-staging/e.html");
    await settle();

    expect(frame.getAttribute("src")).toBe("shipit-preview://assetgen-staging/e.html");
  });

  it("refuses a path that resolves to another host", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen//evil.example/x");
    await settle();

    expect(frame.getAttribute("src")).toBe("shipit-preview://assetgen//evil.example/x");
  });

  it("refuses a backslash before URL parsing can fold it into a slash", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/\\evil.example/x");
    await settle();

    expect(frame.getAttribute("src")).toBe("shipit-preview://assetgen/\\evil.example/x");
  });

  it("refuses an address carrying a newline", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e\n.html");
    await settle();

    expect(frame.getAttribute("src")).toContain("shipit-preview://");
  });

  it("refuses an address with no authority", async () => {
    install();
    const frame = addIframe("shipit-preview:/assetgen/e.html");
    await settle();

    expect(frame.getAttribute("src")).toBe("shipit-preview:/assetgen/e.html");
  });

  it("leaves ordinary srcs alone", async () => {
    install();
    const frame = addIframe("/local/page.html");
    await settle();

    expect(frame.getAttribute("src")).toBe("/local/page.html");
  });

  it("treats the scheme case-insensitively and trims surrounding whitespace", async () => {
    install();
    const frame = addIframe("  ShipIt-Preview://assetgen/e.html  ");
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/e.html`);
  });

  it("does not rewrite an element that is not an iframe", async () => {
    install();
    const img = document.createElement("img");
    img.setAttribute("src", "shipit-preview://assetgen/x.png");
    document.body.appendChild(img);
    await settle();

    expect(img.getAttribute("src")).toBe("shipit-preview://assetgen/x.png");
  });

  // The attribute branch of the mutation observer reaches any element whose
  // `src` changed, not only the ones `scan` walked.
  it("does not rewrite a non-iframe whose src is assigned after insertion", async () => {
    install();
    const img = document.createElement("img");
    document.body.appendChild(img);
    await settle();
    img.setAttribute("src", "shipit-preview://assetgen/x.png");
    await settle();

    expect(img.getAttribute("src")).toBe("shipit-preview://assetgen/x.png");
  });

  it("resolves an embed inside an open shadow root", async () => {
    install();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const frame = document.createElement("iframe");
    frame.setAttribute("src", "shipit-preview://assetgen/e.html");
    shadow.appendChild(frame);
    document.body.appendChild(host);
    await settle();

    expect(frame.getAttribute("src")).toBe(`${SIBLING}/e.html`);
  });
});

describe("buildEmbedResolverScript", () => {
  it("keeps the script body constant whatever the map is, so its CSP hash holds", () => {
    const body = (script: string) =>
      script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");

    expect(body(buildEmbedResolverScript({ a: 1 }))).toBe(EMBED_RESOLVER_SOURCE);
    expect(body(buildEmbedResolverScript({ b: 2, c: 3 }))).toBe(EMBED_RESOLVER_SOURCE);
  });

  it("escapes a service name that would otherwise break out of the attribute", () => {
    const name = 'x"><img src=x onerror=1>';
    const script = buildEmbedResolverScript({ [name]: 3000 });

    const attribute = /data-shipit-services="([^"]*)"/.exec(script)?.[1];
    expect(attribute).not.toContain("<");
    const decoded = (attribute ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    expect(JSON.parse(decoded)).toEqual({ [name]: 3000 });
  });
});
