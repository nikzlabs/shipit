import { describe, it, expect } from "vitest";
import { buildTrackerRegistry } from "./registry.js";
import type { CredentialStore } from "../credential-store.js";
import type { DeclaredTracker } from "../../shared/declared-tracker.js";

const store = (linearToken: string | null = null) =>
  ({ getLinearToken: () => linearToken }) as unknown as CredentialStore;

const gh = (repo: string, name: string): DeclaredTracker => {
  const [owner, repoName] = repo.split("/");
  return { kind: "github", name, owner, repo: repoName };
};
const linear = (team: string, name: string): DeclaredTracker => ({ kind: "linear", name, team });

const build = (args: {
  repo?: { owner: string; repo: string } | null;
  declared?: DeclaredTracker[];
  token?: string | null;
  linearToken?: string | null;
}) =>
  buildTrackerRegistry(store(args.linearToken ?? null), undefined, {
    token: args.token === undefined ? "gh-token" : args.token,
    repo: args.repo ?? null,
    ...(args.declared ? { declared: args.declared } : {}),
  });

describe("buildTrackerRegistry — the registry is the declarations (req 1)", () => {
  it("registers only the session's own repository when nothing is declared", () => {
    const ids = build({ repo: { owner: "acme", repo: "app" }, linearToken: "lin_api_x" })
      .list()
      .map((t) => t.id);
    expect(ids).toEqual(["github"]);
  });

  it("adds one tab per declaration, in declaration order, after the session repo", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("acme/planning", "planning"), linear("SHI", "roadmap")],
      linearToken: "lin_api_x",
    });
    expect(registry.list().map((t) => t.id)).toEqual(["github", "github:acme/planning", "linear:SHI"]);
    expect(registry.list().map((t) => t.label)).toEqual(["GitHub", "planning", "roadmap"]);
    expect(registry.list().map((t) => t.name)).toEqual([undefined, "planning", "roadmap"]);
  });

  it("labels a tab with the declared label, falling back to the name", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [
        { ...gh("acme/planning", "planning"), label: "Planning" },
        linear("SHI", "roadmap"),
      ],
      linearToken: "lin_api_x",
    });
    expect(registry.list().map((t) => t.label)).toEqual(["GitHub", "Planning", "roadmap"]);
    expect(registry.list().map((t) => t.name)).toEqual([undefined, "planning", "roadmap"]);
  });

  it("registers two linear declarations on different teams", () => {
    const registry = build({
      repo: null,
      declared: [linear("SHI", "roadmap"), linear("OPS", "ops")],
      linearToken: "lin_api_x",
    });
    expect(registry.list().map((t) => t.id)).toContain("linear:SHI");
    expect(registry.list().map((t) => t.id)).toContain("linear:OPS");
    expect(registry.get("linear:SHI")!.isConfigured()).toBe(true);
    expect(registry.get("linear:OPS")!.isConfigured()).toBe(true);
  });

  it("reports a declared linear tracker unconfigured when no credential is stored", () => {
    const registry = build({ repo: null, declared: [linear("SHI", "roadmap")] });
    expect(registry.get("linear:SHI")!.isConfigured()).toBe(false);
  });

  it("binds a declared tracker to its own repository, not the session's", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("other-owner/planning", "planning")],
    });
    const info = registry.get("github:other-owner/planning")!.info();
    expect(info.binding).toEqual({ key: "other-owner/planning", name: "other-owner/planning" });
    expect(registry.get("github")!.info().binding).toEqual({ key: "acme/app", name: "acme/app" });
  });

  it("lets a repository name its own repository without minting a second tab", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("Acme/App", "code")],
    });
    expect(registry.list().map((t) => t.id)).toEqual(["github:Acme/App"]);
    expect(registry.list().map((t) => t.name)).toEqual(["code"]);
    expect(registry.get("github")).toBeDefined();
    expect(registry.get("github")!.info().binding).toEqual({ key: "acme/app", name: "acme/app" });
  });

  it("reports a declared tracker unconfigured when GitHub isn't connected", () => {
    const registry = build({ repo: null, token: null, declared: [gh("acme/planning", "planning")] });
    expect(registry.get("github:acme/planning")!.isConfigured()).toBe(false);
  });
});

describe("buildTrackerRegistry — get() and list() agree (req 11)", () => {
  it("does NOT synthesize a tracker for an undeclared repository", () => {
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    expect(registry.get("github:someone-else/private-notes")).toBeUndefined();
  });

  it("does NOT resolve the retired bare `linear` id", () => {
    const registry = build({ repo: null, linearToken: "lin_api_x" });
    expect(registry.get("linear")).toBeUndefined();
  });

  it("returns the registered instance for a declared id", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("acme/planning", "planning")],
    });
    expect(registry.get("github:acme/planning")!.label).toBe("planning");
  });

  it("returns undefined for an unknown tracker rather than falling back", () => {
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    expect(registry.get("jira" as never)).toBeUndefined();
    expect(registry.get("github:not-a-slug" as never)).toBeUndefined();
  });
});

describe("buildTrackerRegistry — getRecorded() is the Undo carve-out (req 11)", () => {
  it("resolves a destination the repository no longer declares", () => {
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    const tracker = registry.getRecorded("github:acme/planning");
    expect(tracker).toBeDefined();
    expect(tracker!.info().binding).toEqual({ key: "acme/planning", name: "acme/planning" });
    expect(registry.list().map((t) => t.id)).not.toContain("github:acme/planning");
  });

  it("resolves an undeclared linear team recorded on a card", () => {
    const registry = build({ repo: null, linearToken: "lin_api_x" });
    const tracker = registry.getRecorded("linear:SHI");
    expect(tracker).toBeDefined();
    expect(tracker!.id).toBe("linear:SHI");
  });

  it("resolves the recorded destination, not wherever the name points now", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("acme/new-planning", "planning")],
    });
    const tracker = registry.getRecorded("github:acme/old-planning");
    expect(tracker!.id).toBe("github:acme/old-planning");
  });

  it("resolves the recorded destination when the name no longer resolves at all", () => {
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    const tracker = registry.getRecorded("github:acme/old-planning");
    expect(tracker!.id).toBe("github:acme/old-planning");
  });

  it("reports where a declared name points today, for the re-point check", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("acme/new-planning", "planning")],
    });
    expect(registry.destinationForName("planning")?.id).toBe("github:acme/new-planning");
    expect(registry.destinationForName("PLANNING")?.id).toBe("github:acme/new-planning");
    expect(registry.destinationForName("gone")).toBeUndefined();
  });

  it("cannot resolve the retired bare `linear` id even on the undo path", () => {
    const registry = build({ repo: null, linearToken: "lin_api_x" });
    expect(registry.getRecorded("linear")).toBeUndefined();
  });
});

describe("buildTrackerRegistry — destinations() is the resolution context", () => {
  it("includes the session's own repository unnamed, plus each declaration named", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("acme/planning", "planning"), linear("SHI", "roadmap")],
    });
    expect(registry.destinations()).toEqual([
      { id: "github", kind: "github", key: "acme/app" },
      { id: "github:acme/planning", kind: "github", key: "acme/planning", name: "planning" },
      { id: "linear:SHI", kind: "linear", key: "SHI", name: "roadmap" },
    ]);
  });

  it("keeps the unnamed own-repo destination alongside a self-declaration", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("acme/app", "code")],
    });
    expect(registry.destinations().map((d) => d.id)).toEqual(["github", "github:acme/app"]);
  });
});

describe("buildTrackerRegistry — declared plugin repositories (docs/262 req 25)", () => {
  const tools = { name: "tools", owner: "acme", repo: "dev-tools", ref: "branch main", commit: "abc123" };

  const withPlugins = (args: {
    declared?: DeclaredTracker[];
    pluginRepos: { name: string; owner: string; repo: string; ref?: string; commit?: string }[];
  }) =>
    buildTrackerRegistry(store(null), undefined, {
      token: "gh-token",
      repo: { owner: "acme", repo: "app" },
      ...(args.declared ? { declared: args.declared } : {}),
      pluginRepos: args.pluginRepos,
    });

  it("is reachable by its declared name but renders no Issues tab", () => {
    const registry = withPlugins({ declared: [gh("acme/planning", "planning")], pluginRepos: [tools] });
    expect(registry.list().map((t) => t.id)).toEqual(["github", "github:acme/planning"]);
    expect(registry.destinations().map((d) => d.id)).toEqual([
      "github",
      "github:acme/planning",
      "github:acme/dev-tools",
    ]);
    expect(registry.get("github:acme/dev-tools")).toBeDefined();
    expect(registry.destinationFor("github:acme/dev-tools")).toMatchObject({
      name: "tools",
      origin: "plugin",
      key: "acme/dev-tools",
    });
  });

  it("aliases onto a tracker declaration of the same repository instead of adding a second destination", () => {
    const registry = withPlugins({
      declared: [gh("acme/planning", "planning")],
      pluginRepos: [{ name: "tools", owner: "acme", repo: "planning" }],
    });
    expect(registry.destinations().map((d) => d.id)).toEqual(["github", "github:acme/planning"]);
    const dest = registry.destinationFor("github:acme/planning");
    expect(dest).toMatchObject({ name: "planning", pluginNames: ["tools"] });
    expect(dest?.origin).toBeUndefined();
    expect(registry.list().map((t) => t.id)).toEqual(["github", "github:acme/planning"]);
  });

  it("aliases across a casing difference between the two declarations", () => {
    const registry = withPlugins({
      declared: [gh("Acme/Planning", "planning")],
      pluginRepos: [{ name: "tools", owner: "acme", repo: "planning" }],
    });
    expect(registry.destinations()).toHaveLength(2);
    expect(registry.destinationFor("github:Acme/Planning")?.pluginNames).toEqual(["tools"]);
  });

  it("registers each declared plugin repository once, in declaration order", () => {
    const registry = withPlugins({
      pluginRepos: [tools, { name: "design", owner: "acme", repo: "design" }],
    });
    expect(registry.destinations().map((d) => d.name)).toEqual([undefined, "tools", "design"]);
    expect(registry.list().map((t) => t.id)).toEqual(["github"]);
  });
});
