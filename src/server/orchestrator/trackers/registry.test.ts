import { describe, it, expect } from "vitest";
import { buildTrackerRegistry } from "./registry.js";
import type { CredentialStore } from "../credential-store.js";
import type { DeclaredTracker } from "../../shared/declared-tracker.js";

/** Minimal CredentialStore stand-in — only the Linear token getter is consulted. */
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
  // The clean break: with no `kind: linear` declaration there is no Linear tab,
  // even on a deployment that has a Linear credential. Requirement 1 removed the
  // built-in tracker; the credential authorizes, it does not declare.
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

  // req 9a — the declared `title` is what the tab shows; the `name` stays the
  // address, so a titled tracker is still referenced as `planning#42`.
  it("labels a tab with the declared title, falling back to the name", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [
        { ...gh("acme/planning", "planning"), title: "Planning" },
        linear("SHI", "roadmap"),
      ],
      linearToken: "lin_api_x",
    });
    expect(registry.list().map((t) => t.label)).toEqual(["GitHub", "Planning", "roadmap"]);
    expect(registry.list().map((t) => t.name)).toEqual([undefined, "planning", "roadmap"]);
  });

  // req 3 — a repository may declare two Linear trackers on different teams, and
  // each gets its own destination id and its own tab.
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
    // The session's own destination is untouched.
    expect(registry.get("github")!.info().binding).toEqual({ key: "acme/app", name: "acme/app" });
  });

  // req 12 — a repository may declare its OWN repository in order to give it a
  // name. That must not produce two tabs listing the same issues, and the bare
  // `github` id must stay resolvable for the operations that name nothing.
  it("lets a repository name its own repository without minting a second tab", () => {
    const registry = build({
      repo: { owner: "acme", repo: "app" },
      declared: [gh("Acme/App", "code")], // case-insensitive: GitHub slugs are
    });
    expect(registry.list().map((t) => t.id)).toEqual(["github:Acme/App"]);
    expect(registry.list().map((t) => t.name)).toEqual(["code"]);
    // Still reachable unnamed — req 12's exception survives the self-declaration.
    expect(registry.get("github")).toBeDefined();
    expect(registry.get("github")!.info().binding).toEqual({ key: "acme/app", name: "acme/app" });
  });

  it("reports a declared tracker unconfigured when GitHub isn't connected", () => {
    const registry = build({ repo: null, token: null, declared: [gh("acme/planning", "planning")] });
    expect(registry.get("github:acme/planning")!.isConfigured()).toBe(false);
  });
});

describe("buildTrackerRegistry — get() and list() agree (req 11)", () => {
  // The pre-docs/248 registry deliberately synthesized a tracker for any
  // well-formed `github:owner/repo`, so `--repo` could reach anything the
  // credential could see. Requirement 11 forbids that: an address identifying no
  // declared destination has nowhere to go, because req 1 leaves no destination
  // outside the declarations.
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
    // req 17 — ShipIt never substitutes one destination for another, so an
    // unresolvable id is an error the caller surfaces, not a redirect to the
    // session's repo.
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    expect(registry.get("jira" as never)).toBeUndefined();
    expect(registry.get("github:not-a-slug" as never)).toBeUndefined();
  });
});

describe("buildTrackerRegistry — getRecorded() is the Undo carve-out (req 11)", () => {
  // Reversing a write grants no access the write did not already have: the card
  // could only exist if the destination was declared when it was written. So an
  // Undo resolves against the recorded destination even after the repository
  // stops declaring it — otherwise every recorded action would be stranded
  // behind a config edit.
  it("resolves a destination the repository no longer declares", () => {
    const registry = build({ repo: { owner: "acme", repo: "app" } });
    const tracker = registry.getRecorded("github:acme/planning");
    expect(tracker).toBeDefined();
    expect(tracker!.info().binding).toEqual({ key: "acme/planning", name: "acme/planning" });
    // ...and it stays absent from the tab list.
    expect(registry.list().map((t) => t.id)).not.toContain("github:acme/planning");
  });

  it("resolves an undeclared linear team recorded on a card", () => {
    const registry = build({ repo: null, linearToken: "lin_api_x" });
    const tracker = registry.getRecorded("linear:SHI");
    expect(tracker).toBeDefined();
    expect(tracker!.id).toBe("linear:SHI");
  });

  // req 16's exception — Undo is NOT re-targeted by a re-pointed name. It acts on
  // the destination the write actually reached, because the snapshot it restores
  // belongs to that issue. `undoIssueWrite` uses `destinationForName` to detect
  // the re-point and refuse; the registry itself simply never follows the name.
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
    // A card written before docs/248 recorded no destination beyond "Linear",
    // which named the deployment's stored team — state this build no longer has.
    // Requirement 20 permits that break; what matters is that it fails closed.
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
    // Both are reachable — unnamed for req 12's exception, named for req 15's
    // emitted references — even though only one renders as a tab.
    expect(registry.destinations().map((d) => d.id)).toEqual(["github", "github:acme/app"]);
  });
});
