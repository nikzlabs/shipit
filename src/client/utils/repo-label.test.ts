import { describe, it, expect } from "vitest";
import { parseRepoLabel, repoLabelToNewPath, parseNewSessionSlug } from "./repo-label.js";

describe("parseRepoLabel", () => {
  it("extracts owner/repo from GitHub HTTPS URL", () => {
    expect(parseRepoLabel("https://github.com/anthropics/shipit.git")).toBe("anthropics/shipit");
  });

  it("extracts owner/repo from GitHub SSH URL", () => {
    expect(parseRepoLabel("git@github.com:anthropics/shipit.git")).toBe("anthropics/shipit");
  });

  it("handles generic HTTPS URLs", () => {
    expect(parseRepoLabel("https://example.com/path/repo")).toBe("example.com/path/repo");
  });

  it("strips .git suffix from generic URLs", () => {
    expect(parseRepoLabel("https://example.com/path/repo.git")).toBe("example.com/path/repo");
  });
});

describe("repoLabelToNewPath", () => {
  it("builds /repo/{owner}/{repo}/new path", () => {
    expect(repoLabelToNewPath("https://github.com/anthropics/shipit.git")).toBe(
      "/repo/anthropics/shipit/new",
    );
  });

  it("avoids collision with /session route", () => {
    const path = repoLabelToNewPath("https://github.com/session/myrepo.git");
    expect(path).toBe("/repo/session/myrepo/new");
  });

  it("avoids collision with /api route", () => {
    const path = repoLabelToNewPath("https://github.com/api/myrepo.git");
    expect(path).toBe("/repo/api/myrepo/new");
  });
});

describe("parseNewSessionSlug", () => {
  it("extracts slug from /repo/{slug}/new path", () => {
    expect(parseNewSessionSlug("/repo/anthropics/shipit/new")).toBe("anthropics/shipit");
  });

  it("returns undefined for plain /new path", () => {
    expect(parseNewSessionSlug("/new")).toBeUndefined();
  });

  it("returns undefined for /{slug}/new without /repo/ prefix", () => {
    expect(parseNewSessionSlug("/anthropics/shipit/new")).toBeUndefined();
  });

  it("returns undefined for /session/:id path", () => {
    expect(parseNewSessionSlug("/session/abc-123")).toBeUndefined();
  });

  it("returns undefined for /repo//new (empty slug)", () => {
    expect(parseNewSessionSlug("/repo//new")).toBeUndefined();
  });

  it("handles non-GitHub repo slugs with extra segments", () => {
    expect(parseNewSessionSlug("/repo/example.com/path/repo/new")).toBe("example.com/path/repo");
  });

  it("decodes URI-encoded slugs", () => {
    expect(parseNewSessionSlug("/repo/owner%2Frepo/new")).toBe("owner/repo");
  });
});
