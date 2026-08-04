import { describe, it, expect } from "vitest";
import { buildTrackerRegistry } from "./registry.js";
import type { CredentialStore } from "../credential-store.js";
import type { DeclaredTracker } from "../../shared/shipit-config.js";

/** Minimal CredentialStore stand-in — only the Linear getters are consulted. */
const noLinear = {
  getLinearToken: () => null,
  getLinearTeam: () => null,
} as unknown as CredentialStore;

const declared = (repo: string, label?: string): DeclaredTracker => {
  const [owner, name] = repo.split("/");
  return { kind: "github", owner, repo: name, label: label ?? name };
};

const build = (args: {
  repo?: { owner: string; repo: string } | null;
  declared?: DeclaredTracker[];
  token?: string | null;
}) =>
  buildTrackerRegistry(noLinear, undefined, {
    token: args.token === undefined ? "gh-token" : args.token,
    repo: args.repo ?? null,
    ...(args.declared ? { declared: args.declared } : {}),
  });

describe("buildTrackerRegistry — declared trackers", () => {
  it("registers Linear + the session repo when nothing is declared", () => {
    const ids = build({ repo: { owner: "acme", repo: "app" } })
      .list()
      .map((t) => t.id);
    expect(ids).toEqual(["linear", "github"]);
  });

  it("adds one tab per declaration, in declaration order, after the session repo", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [declared("acme/planning", "Planning"), declared("acme/roadmap")],
    });
    expect(registry.list().map((t) => t.id)).toEqual([
      "linear",
      "github",
      "github:acme/planning",
      "github:acme/roadmap",
    ]);
    expect(registry.list().map((t) => t.label)).toEqual(["Linear", "GitHub", "Planning", "roadmap"]);
  });

  it("binds a declared tracker to its own repository, not the session's", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [declared("other-owner/planning")],
    });
    const info = registry.get("github:other-owner/planning")!.info();
    expect(info.binding).toEqual({ key: "other-owner/planning", name: "other-owner/planning" });
    // The session's own tab is untouched — no existing destination moved.
    expect(registry.get("github")!.info().binding).toEqual({ key: "acme/app", name: "acme/app" });
  });

  it("drops a declaration of the session's own repo so it doesn't produce two identical tabs", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [declared("Acme/App")], // case-insensitive: GitHub slugs are
    });
    expect(registry.list().map((t) => t.id)).toEqual(["linear", "github"]);
  });

  it("reports a declared tracker unconfigured when GitHub isn't connected", () => {
    const registry = build({ repo: null, token: null, declared: [declared("acme/planning")] });
    expect(registry.get("github:acme/planning")!.isConfigured()).toBe(false);
  });
});

describe("buildTrackerRegistry — get() resolves any reachable repository", () => {
  // The list()/get() asymmetry is the design (req 3 + 5): declarations drive
  // TABS, not reachability. `--repo` may name any repository the credential can
  // reach, so `get()` synthesizes an adapter for a well-formed qualified id even
  // though no tab exists for it. A membership check here would be a second,
  // weaker gate that only ever produced false negatives — GitHub authorization
  // is the real one, and it applies at request time.
  it("synthesizes a tracker for an undeclared repository", () => {
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    const tracker = registry.get("github:someone-else/private-notes");
    expect(tracker).toBeDefined();
    expect(tracker!.info().binding).toEqual({
      key: "someone-else/private-notes",
      name: "someone-else/private-notes",
    });
    // ...and it stays absent from the tab list.
    expect(registry.list().map((t) => t.id)).not.toContain("github:someone-else/private-notes");
  });

  it("returns the registered instance for a declared id rather than synthesizing a second", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [declared("acme/planning", "Planning")],
    });
    // The declared label survives — proof the registered tracker won.
    expect(registry.get("github:acme/planning")!.label).toBe("Planning");
  });

  it("returns undefined for an unknown tracker rather than falling back", () => {
    // req 3 rule 3 — ShipIt never substitutes one repository for another, so an
    // unresolvable id is an error the caller surfaces, not a redirect to the
    // session's repo.
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    expect(registry.get("jira" as never)).toBeUndefined();
    expect(registry.get("github:not-a-slug" as never)).toBeUndefined();
  });
});
