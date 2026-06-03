import { describe, it, expect } from "vitest";
import { parseRepoFileLink } from "./repo-file-link.js";

describe("parseRepoFileLink", () => {
  it("parses a plain repo-relative path", () => {
    expect(parseRepoFileLink("src/server/foo.ts")).toEqual({ path: "src/server/foo.ts" });
  });

  it("parses a `path:line` reference (the agent's convention)", () => {
    expect(parseRepoFileLink("src/server/foo.ts:123")).toEqual({
      path: "src/server/foo.ts",
      line: 123,
    });
  });

  it("parses `path:line:col`, keeping the line", () => {
    expect(parseRepoFileLink("src/foo.ts:12:5")).toEqual({ path: "src/foo.ts", line: 12 });
  });

  it("parses a GitHub-style #L line fragment", () => {
    expect(parseRepoFileLink("src/foo.ts#L42")).toEqual({ path: "src/foo.ts", line: 42 });
  });

  it("treats a top-level filename with a line suffix as a file, not a URL scheme", () => {
    expect(parseRepoFileLink("README.md:10")).toEqual({ path: "README.md", line: 10 });
  });

  it("strips a leading ./", () => {
    expect(parseRepoFileLink("./docs/plan.md")).toEqual({ path: "docs/plan.md" });
  });

  it("returns null for http(s) URLs", () => {
    expect(parseRepoFileLink("https://example.com/foo")).toBeNull();
    expect(parseRepoFileLink("http://example.com")).toBeNull();
  });

  it("returns null for mailto: and tel: links", () => {
    expect(parseRepoFileLink("mailto:hi@example.com")).toBeNull();
    expect(parseRepoFileLink("tel:+15551234")).toBeNull();
  });

  it("returns null for protocol-relative URLs", () => {
    expect(parseRepoFileLink("//cdn.example.com/x.js")).toBeNull();
  });

  it("returns null for in-page anchors", () => {
    expect(parseRepoFileLink("#section-heading")).toBeNull();
  });

  it("returns null for empty / missing hrefs", () => {
    expect(parseRepoFileLink(undefined)).toBeNull();
    expect(parseRepoFileLink(null)).toBeNull();
    expect(parseRepoFileLink("")).toBeNull();
  });
});
