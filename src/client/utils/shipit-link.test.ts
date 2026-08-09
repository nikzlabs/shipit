import { describe, it, expect } from "vitest";
import {
  parseShipitLink,
  isShipitLinkHref,
  slugifyHeading,
  type ShipitLink,
} from "./shipit-link.js";

/** Narrow to a successfully parsed link, failing the test with the reason if not. */
function ok(link: ShipitLink | null): Exclude<ShipitLink, { kind: "invalid" }> {
  expect(link).not.toBeNull();
  if (link === null) throw new Error("unreachable");
  if (link.kind === "invalid") throw new Error(`expected a valid link, got: ${link.reason}`);
  return link;
}

/** Narrow to a rejected pointer — one that still renders and toasts on click. */
function rejected(link: ShipitLink | null): string {
  expect(link).not.toBeNull();
  if (link === null) throw new Error("unreachable");
  expect(link.kind).toBe("invalid");
  return link.kind === "invalid" ? link.reason : "";
}

describe("isShipitLinkHref", () => {
  it("recognises both schemes, case-insensitively", () => {
    expect(isShipitLinkHref("shipit-preview://web/")).toBe(true);
    expect(isShipitLinkHref("shipit-present:/persist/x.html")).toBe(true);
    expect(isShipitLinkHref("SHIPIT-PRESENT:/persist/x.html")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isShipitLinkHref(undefined)).toBe(false);
    expect(isShipitLinkHref("https://example.com")).toBe(false);
    expect(isShipitLinkHref("src/foo.ts:12")).toBe(false);
    // Near-misses must not be captured — a longer scheme is a different scheme.
    expect(isShipitLinkHref("shipit-previewer://web/")).toBe(false);
    expect(isShipitLinkHref("shipit-issue:SHI-1")).toBe(false);
  });
});

describe("parseShipitLink — not our link", () => {
  it("returns null so the caller falls through to its other branches", () => {
    expect(parseShipitLink(undefined)).toBeNull();
    expect(parseShipitLink("https://example.com/x")).toBeNull();
    expect(parseShipitLink("src/foo.ts:12")).toBeNull();
    expect(parseShipitLink("#anchor")).toBeNull();
  });
});

describe("parseShipitLink — preview", () => {
  it("parses a service and path", () => {
    const link = ok(parseShipitLink("shipit-preview://web/requirements/7"));
    expect(link).toEqual({
      kind: "preview",
      service: "web",
      target: "/requirements/7",
      render: "link",
    });
  });

  it("keeps the query and fragment on the target, for the page to read", () => {
    const link = ok(parseShipitLink("shipit-preview://web/reqs?highlight=7&open=1#req-7"));
    expect(link.kind === "preview" && link.target).toBe("/reqs?highlight=7&open=1#req-7");
  });

  it("addresses the app as a whole when there is no path (req 5)", () => {
    expect(ok(parseShipitLink("shipit-preview://web")).kind === "preview").toBe(true);
    expect(ok(parseShipitLink("shipit-preview://web")))
      .toMatchObject({ service: "web", target: "/" });
    expect(ok(parseShipitLink("shipit-preview://web/"))).toMatchObject({ target: "/" });
    expect(ok(parseShipitLink("shipit-preview://web?a=1"))).toMatchObject({ target: "/?a=1" });
    expect(ok(parseShipitLink("shipit-preview://web#top"))).toMatchObject({ target: "/#top" });
  });

  it("reads the service from the raw href, preserving case", () => {
    // `URL.hostname` would lowercase this and silently fail the exact match
    // against a Compose service actually named `webUI`.
    expect(ok(parseShipitLink("shipit-preview://webUI/x"))).toMatchObject({ service: "webUI" });
  });

  it("rejects an address with no service", () => {
    expect(rejected(parseShipitLink("shipit-preview:/requirements/7"))).toMatch(/service name/);
    expect(rejected(parseShipitLink("shipit-preview:///x"))).toMatch(/names no service/);
  });

  it("rejects a port or credentials in the authority (req 8)", () => {
    expect(rejected(parseShipitLink("shipit-preview://web:3000/x"))).toMatch(/not a valid service/);
    expect(rejected(parseShipitLink("shipit-preview://user@web/x"))).toMatch(/not a valid service/);
  });

  it("rejects characters that make a URL parse differently from how it reads", () => {
    // WHATWG parsing folds `\` into `/`, so this would resolve to a foreign host
    // while passing a naive "starts with a single slash" test.
    expect(rejected(parseShipitLink("shipit-preview://web/\\evil.example/x"))).toBeTruthy();
    expect(rejected(parseShipitLink("shipit-preview://web/\tevil.example/x"))).toBeTruthy();
    expect(rejected(parseShipitLink("shipit-preview://web/a\nb"))).toBeTruthy();
    expect(rejected(parseShipitLink("shipit-preview://web/a\rb"))).toBeTruthy();
  });

  it("rejects a protocol-relative path", () => {
    expect(rejected(parseShipitLink("shipit-preview://web//evil.example/x")))
      .toMatch(/single \//);
  });

  it("rejects rather than truncates an overlong address", () => {
    // A truncated destination is a different destination — the reason this
    // parser does not reuse `sanitizePreviewPath`'s repair behaviour.
    const long = `shipit-preview://web/${"a".repeat(4000)}`;
    expect(rejected(parseShipitLink(long))).toMatch(/too long/);
  });
});

describe("parseShipitLink — present", () => {
  it("parses a file path", () => {
    expect(ok(parseShipitLink("shipit-present:/persist/reqs.html"))).toEqual({
      kind: "present",
      filePath: "/persist/reqs.html",
      render: "link",
    });
  });

  it("parses a fragment without its # and decoded once", () => {
    expect(ok(parseShipitLink("shipit-present:/persist/reqs.html#req-7"))).toMatchObject({
      filePath: "/persist/reqs.html",
      fragment: "req-7",
    });
    expect(ok(parseShipitLink("shipit-present:/persist/reqs.md#a%20b"))).toMatchObject({
      fragment: "a b",
    });
  });

  it("normalises a leading ./ so both forms name the same artifact", () => {
    expect(ok(parseShipitLink("shipit-present:./docs/plan.md"))).toMatchObject({
      filePath: "docs/plan.md",
    });
  });

  it("percent-decodes the file path once", () => {
    expect(ok(parseShipitLink("shipit-present:/persist/my%20file.md"))).toMatchObject({
      filePath: "/persist/my file.md",
    });
  });

  it("rejects an empty or malformed path", () => {
    expect(rejected(parseShipitLink("shipit-present:"))).toMatch(/names no file/);
    expect(rejected(parseShipitLink("shipit-present:#req-7"))).toMatch(/names no file/);
    expect(rejected(parseShipitLink("shipit-present:%ZZ"))).toMatch(/not valid|is not valid/);
  });

  it("rejects an overlong fragment", () => {
    const link = `shipit-present:/persist/x.md#${"a".repeat(300)}`;
    expect(rejected(parseShipitLink(link))).toMatch(/fragment is too long/);
  });
});

describe("parseShipitLink — the render form (req 1)", () => {
  it("defaults to a link", () => {
    expect(ok(parseShipitLink("shipit-preview://web/x")).render).toBe("link");
    expect(ok(parseShipitLink("shipit-present:/x.md")).render).toBe("link");
  });

  it("honours each allowed form on both schemes", () => {
    for (const form of ["link", "badge", "button"] as const) {
      expect(ok(parseShipitLink(`shipit-preview://web/x?shipit-render=${form}`)).render).toBe(form);
      expect(ok(parseShipitLink(`shipit-present:/x.md?shipit-render=${form}`)).render).toBe(form);
    }
  });

  it("strips itself from the navigated URL, so the page never sees it", () => {
    const link = ok(parseShipitLink("shipit-preview://web/x?a=1&shipit-render=button&b=2#f"));
    expect(link.kind === "preview" && link.target).toBe("/x?a=1&b=2#f");
  });

  it("leaves no dangling separators when it is the only parameter", () => {
    expect(ok(parseShipitLink("shipit-preview://web/x?shipit-render=badge")))
      .toMatchObject({ target: "/x" });
    expect(ok(parseShipitLink("shipit-preview://web/x?shipit-render=badge#f")))
      .toMatchObject({ target: "/x#f" });
  });

  it("passes the rest of the query through byte-for-byte", () => {
    // Round-tripping through URLSearchParams would re-encode these and hand the
    // page a different string than the agent wrote.
    const link = ok(parseShipitLink("shipit-preview://web/x?q=a%7Eb+c&shipit-render=link"));
    expect(link.kind === "preview" && link.target).toBe("/x?q=a%7Eb+c");
  });

  it("rejects an unknown form", () => {
    expect(rejected(parseShipitLink("shipit-preview://web/x?shipit-render=card")))
      .toMatch(/must be one of/);
  });

  it("rejects a repeated shipit-render rather than taking the last", () => {
    expect(rejected(parseShipitLink("shipit-preview://web/x?shipit-render=link&shipit-render=button")))
      .toMatch(/repeats/);
  });

  it("keeps a rejected pointer's requested form, so it renders as authored", () => {
    // Req 10: an unopenable pointer still renders — as the form the agent chose,
    // not silently demoted to an inline link. True on both schemes, which means
    // the form has to be read BEFORE the rest of the address is validated.
    for (const href of [
      "shipit-present:?shipit-render=button",
      "shipit-preview://web:3000/x?shipit-render=button",
      "shipit-preview:///x?shipit-render=button",
      "shipit-preview://web//evil.example/x?shipit-render=button",
    ]) {
      const link = parseShipitLink(href);
      expect(link?.kind, href).toBe("invalid");
      expect(link?.render, href).toBe("button");
    }
  });

  it("does not mistake a page's own similarly-named parameter for ShipIt's", () => {
    const link = ok(parseShipitLink("shipit-preview://web/x?shipit-renderer=1&render=button"));
    expect(link).toMatchObject({ target: "/x?shipit-renderer=1&render=button", render: "link" });
  });
});

describe("slugifyHeading", () => {
  it("lowercases, strips punctuation and hyphenates whitespace", () => {
    expect(slugifyHeading("Requirement 7")).toBe("requirement-7");
    expect(slugifyHeading("The page-facing contract")).toBe("the-page-facing-contract");
    expect(slugifyHeading("Open questions?")).toBe("open-questions");
    expect(slugifyHeading("  Spaced   out  ")).toBe("spaced-out");
  });

  it("keeps the text of inline code and emphasis", () => {
    // Callers pass rendered `textContent`, so the marks are already gone.
    expect(slugifyHeading("Using parseShipitLink()")).toBe("using-parseshipitlink");
  });

  it("trims hyphens left by stripped punctuation", () => {
    expect(slugifyHeading("— Attention —")).toBe("attention");
    expect(slugifyHeading("...")).toBe("");
  });
});
