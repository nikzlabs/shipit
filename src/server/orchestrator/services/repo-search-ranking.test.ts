import { describe, it, expect } from "vitest";
import { rankRepoSearchResults } from "./repo-search-ranking.js";
import type { GitHubRepoSummary } from "../github-auth-repos.js";

function repo(fullName: string): GitHubRepoSummary {
  return {
    fullName,
    description: null,
    private: false,
    defaultBranch: "main",
    cloneUrl: `https://github.com/${fullName}.git`,
  };
}

const names = (repos: GitHubRepoSummary[]) => repos.map((r) => r.fullName);

describe("rankRepoSearchResults", () => {
  it("puts a matching personal repo ahead of every search result", () => {
    const ranked = rankRepoSearchResults(
      "shipit",
      [repo("me/shipit")],
      [repo("popular/shipit-clone"), repo("other/shipit")],
    );

    expect(names(ranked)).toEqual(["me/shipit", "popular/shipit-clone", "other/shipit"]);
  });

  it("surfaces a personal repo the search never returned", () => {
    const ranked = rankRepoSearchResults("invoices", [repo("me/invoices")], []);

    expect(names(ranked)).toEqual(["me/invoices"]);
  });

  it("drops personal repos that do not match the query", () => {
    const ranked = rankRepoSearchResults(
      "invoices",
      [repo("me/unrelated"), repo("me/invoices-api")],
      [],
    );

    expect(names(ranked)).toEqual(["me/invoices-api"]);
  });

  it("ranks exact name, then prefix, then substring, then owner", () => {
    const ranked = rankRepoSearchResults(
      "notes",
      [repo("me/team-notes"), repo("notes/website"), repo("me/notes-app"), repo("me/notes")],
      [],
    );

    expect(names(ranked)).toEqual(["me/notes", "me/notes-app", "me/team-notes", "notes/website"]);
  });

  it("keeps push order within a tier", () => {
    const ranked = rankRepoSearchResults("api", [repo("me/api-new"), repo("me/api-old")], []);

    expect(names(ranked)).toEqual(["me/api-new", "me/api-old"]);
  });

  it("matches case-insensitively", () => {
    const ranked = rankRepoSearchResults("SHIPit", [repo("Me/ShipIt")], []);

    expect(names(ranked)).toEqual(["Me/ShipIt"]);
  });

  it("matches a full owner/name query", () => {
    const ranked = rankRepoSearchResults("me/ship", [repo("me/shipit")], []);

    expect(names(ranked)).toEqual(["me/shipit"]);
  });

  it("does not let an owner/name query match across the slash", () => {
    // "acme/ship-cli" contains "me/ship" only by spanning the owner boundary.
    const newer = Array.from({ length: 10 }, (_, i) => repo(`acme/ship-${i}`));
    const ranked = rankRepoSearchResults("me/ship", [...newer, repo("me/shipit")], []);

    expect(names(ranked)).toEqual(["me/shipit"]);
  });

  it("lists an owner's repos for a bare owner/ query", () => {
    const ranked = rankRepoSearchResults("me/", [repo("me/newest"), repo("other/thing"), repo("me/older")], []);

    expect(names(ranked)).toEqual(["me/newest", "me/older"]);
  });

  it("does not let an unqualified query match across the slash", () => {
    const ranked = rankRepoSearchResults("e/s", [repo("me/shipit")], []);

    expect(names(ranked)).toEqual([]);
  });

  it("does not repeat a repo returned by both sources", () => {
    const ranked = rankRepoSearchResults("shipit", [repo("me/shipit")], [repo("Me/ShipIt")]);

    expect(names(ranked)).toEqual(["me/shipit"]);
  });

  it("leaves room for search results when many personal repos match", () => {
    const personal = Array.from({ length: 30 }, (_, i) => repo(`me/api-${i}`));
    const ranked = rankRepoSearchResults("api", personal, [repo("other/api")]);

    expect(ranked.filter((r) => r.fullName.startsWith("me/"))).toHaveLength(10);
    expect(names(ranked)).toContain("other/api");
  });

  it("caps the combined list", () => {
    const personal = Array.from({ length: 30 }, (_, i) => repo(`me/api-${i}`));
    const searched = Array.from({ length: 30 }, (_, i) => repo(`other/api-${i}`));

    expect(rankRepoSearchResults("api", personal, searched)).toHaveLength(20);
  });
});
