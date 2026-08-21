import { describe, it, expect } from "vitest";
import { parsePluginRepos } from "./plugin-repos.js";
import {
  pluginFeedbackRepos,
  pluginFeedbackTrackerId,
  withPluginFeedbackContext,
} from "./plugin-feedback.js";

/** Parse a consumer block the way `shipit-config.ts` does. */
function parse(raw: unknown) {
  const warnings: string[] = [];
  return parsePluginRepos(raw, [], warnings);
}

describe("pluginFeedbackRepos (docs/262 req 25)", () => {
  it("makes one destination per declared repository, named by its declaration", () => {
    const config = parse({
      repos: [
        { repo: "acme/dev-tools", name: "tools", branch: "main" },
        { repo: "acme/design", name: "design", pin: "v1.2.0" },
      ],
      // Two plugins from one repository is still ONE feedback destination: the
      // repository is what would have to fix the report.
      use: [
        { plugin: "requirements", from: "tools" },
        { plugin: "probe", from: "tools" },
      ],
    });
    expect(pluginFeedbackRepos(config)).toEqual([
      { name: "tools", owner: "acme", repo: "dev-tools", ref: "branch main" },
      { name: "design", owner: "acme", repo: "design", ref: "pin v1.2.0" },
    ]);
  });

  it("records the default branch when the declaration names no ref", () => {
    const config = parse({ repos: [{ repo: "acme/dev-tools", name: "tools" }] });
    expect(pluginFeedbackRepos(config)[0].ref).toBe("default branch");
  });

  // req 27 — a self-declared repository's issues ARE this session's own
  // repository's issues, which every session already reaches without a name.
  it("registers nothing for `repo: self`", () => {
    const config = parse({ repos: [{ repo: "self", name: "me" }] });
    expect(pluginFeedbackRepos(config)).toEqual([]);
  });

  it("routes to the plugin repository's own GitHub Issues", () => {
    const config = parse({ repos: [{ repo: "acme/dev-tools", name: "tools" }] });
    expect(pluginFeedbackTrackerId(pluginFeedbackRepos(config)[0])).toBe("github:acme/dev-tools");
  });
});

describe("withPluginFeedbackContext (docs/262 reqs 15, 25)", () => {
  const repo = { name: "tools", owner: "acme", repo: "dev-tools", ref: "branch main" };

  it("appends the exact running commit under the author's report", () => {
    const body = withPluginFeedbackContext("The reqs CLI drops --root.", {
      ...repo,
      commit: "9f2a1b3c4d5e6f708192a3b4c5d6e7f809a1b2c3",
    });
    expect(body).toContain("The reqs CLI drops --root.");
    expect(body).toContain("plugin repository `tools`");
    expect(body).toContain("branch main @ `9f2a1b3c4d5e6f708192a3b4c5d6e7f809a1b2c3`");
    // The report's own content comes first — the context is a footer, not a
    // preamble that pushes the reproduction below the fold.
    expect(body.indexOf("The reqs CLI")).toBeLessThan(body.indexOf("Version in use"));
  });

  it("says the version is not active rather than inventing one", () => {
    const body = withPluginFeedbackContext("Broken.", repo);
    expect(body).toContain("no plugin generation is active");
    expect(body).not.toContain("undefined");
  });

  it("survives an empty body", () => {
    expect(withPluginFeedbackContext("", { ...repo, commit: "abc123" })).toContain("Version in use");
  });

  // A diff in the body is req 25's "proposed fix" — the footer must not land
  // inside the fence and break it.
  it("keeps a trailing diff fence intact", () => {
    const report = "Fix:\n\n```diff\n-a\n+b\n```";
    const body = withPluginFeedbackContext(report, { ...repo, commit: "abc123" });
    expect(body).toContain("```diff\n-a\n+b\n```\n\n---");
  });
});
