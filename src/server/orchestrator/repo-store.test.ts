import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { RepoStore } from "./repo-store.js";
import { REPO_COLOR_ASSIGNMENT_ORDER } from "../shared/repo-colors.js";

let dbManager: DatabaseManager;
let store: RepoStore;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  store = new RepoStore(dbManager);
});

afterEach(() => {
  dbManager.close();
});

describe("RepoStore", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("adds a repo", () => {
    const repo = store.add("https://github.com/owner/repo.git");
    expect(repo.url).toBe("https://github.com/owner/repo.git");
    expect(repo.status).toBe("cloning");
    expect(store.list()).toHaveLength(1);
  });

  it("returns existing repo on duplicate add", () => {
    store.add("https://github.com/owner/repo.git");
    const repo2 = store.add("https://github.com/owner/repo.git");
    expect(store.list()).toHaveLength(1);
    expect(repo2.url).toBe("https://github.com/owner/repo.git");
  });

  // docs/262 req 19 — the row key is the credential-free URL, in EVERY method
  // that takes one. Stripping in `add` alone would store the clean URL and then
  // leave `setReady`/`get`/`setWarmSessionId` addressing a row that never
  // existed, which is a repo stuck at status "cloning" forever.
  it("treats a credentialed URL and its clean twin as one row", () => {
    const credentialed = "https://x-access-token:pw@github.com/owner/repo.git";
    const clean = "https://github.com/owner/repo.git";

    expect(store.add(credentialed).url).toBe(clean);
    expect(store.list()).toHaveLength(1);
    expect(store.add(clean).url).toBe(clean);
    expect(store.list()).toHaveLength(1);

    store.setReady(credentialed);
    expect(store.get(clean)?.status).toBe("ready");
    expect(store.get(credentialed)?.status).toBe("ready");
    expect(store.has(credentialed)).toBe(true);

    store.setWarmSessionId(credentialed, "warm-1");
    expect(store.get(clean)?.warmSessionId).toBe("warm-1");
    expect(store.remove(credentialed)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("setReady changes status", () => {
    store.add("https://github.com/owner/repo.git");
    store.setReady("https://github.com/owner/repo.git");
    expect(store.get("https://github.com/owner/repo.git")?.status).toBe("ready");
  });

  it("setWarmSessionId stores and clears warm session", () => {
    store.add("https://github.com/owner/repo.git");
    store.setWarmSessionId("https://github.com/owner/repo.git", "session-123");
    expect(store.get("https://github.com/owner/repo.git")?.warmSessionId).toBe("session-123");
    store.setWarmSessionId("https://github.com/owner/repo.git", undefined);
    expect(store.get("https://github.com/owner/repo.git")?.warmSessionId).toBeUndefined();
  });

  it("touch updates lastUsedAt", () => {
    const repo = store.add("https://github.com/owner/repo.git");
    const _originalDate = repo.lastUsedAt;
    store.touch("https://github.com/owner/repo.git");
    const updated = store.get("https://github.com/owner/repo.git");
    expect(updated?.lastUsedAt).toBeTruthy();
  });

  it("remove deletes a repo", () => {
    store.add("https://github.com/owner/repo.git");
    expect(store.remove("https://github.com/owner/repo.git")).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.has("https://github.com/owner/repo.git")).toBe(false);
  });

  it("remove returns false for unknown repo", () => {
    expect(store.remove("https://github.com/unknown/repo.git")).toBe(false);
  });

  it("persists across instances", () => {
    store.add("https://github.com/owner/repo.git");
    store.setReady("https://github.com/owner/repo.git");

    const store2 = new RepoStore(dbManager);
    expect(store2.list()).toHaveLength(1);
    expect(store2.get("https://github.com/owner/repo.git")?.status).toBe("ready");
  });

  it("list sorts by lastUsedAt descending", () => {
    store.add("https://github.com/a/repo.git");
    store.add("https://github.com/b/repo.git");
    // The second add is more recent, so it should be first
    const list = store.list();
    expect(list[0].url).toBe("https://github.com/b/repo.git");
    expect(list[1].url).toBe("https://github.com/a/repo.git");
  });

  it("clear empties all data", () => {
    store.add("https://github.com/owner/repo.git");
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  it("has returns correct boolean", () => {
    expect(store.has("https://github.com/owner/repo.git")).toBe(false);
    store.add("https://github.com/owner/repo.git");
    expect(store.has("https://github.com/owner/repo.git")).toBe(true);
  });

  describe("agent-merge grant (docs/287)", () => {
    const URL = "https://github.com/owner/repo.git";

    it("a freshly-added repo does not allow agent merges", () => {
      const repo = store.add(URL);
      expect(repo.allowAgentMerge).toBe(false);
      expect(store.allowsAgentMerge(URL)).toBe(false);
    });

    it("setAllowAgentMerge flips the flag and the read reflects it", () => {
      store.add(URL);
      expect(store.setAllowAgentMerge(URL, true)).toBe("ok");
      expect(store.allowsAgentMerge(URL)).toBe(true);
      expect(store.get(URL)?.allowAgentMerge).toBe(true);
      store.setAllowAgentMerge(URL, false);
      expect(store.allowsAgentMerge(URL)).toBe(false);
    });

    it("is keyed by GitHub identity — including the spellings trust cannot collapse", () => {
      // canonicalRepoKey (which `trusted` uses) splits these three; a
      // permission must not, or a grant made under one spelling silently
      // fails to apply under another.
      store.add(URL);
      store.setAllowAgentMerge("git@github.com:Owner/Repo.git", true);
      expect(store.allowsAgentMerge(URL)).toBe(true);
      expect(store.allowsAgentMerge("https://github.com/OWNER/REPO")).toBe(true);
      expect(store.allowsAgentMerge("ssh://git@github.com/owner/repo.git")).toBe(true);
    });

    it("is per-repository", () => {
      const OTHER = "https://github.com/other/thing.git";
      store.add(URL);
      store.add(OTHER);
      store.setAllowAgentMerge(URL, true);
      expect(store.allowsAgentMerge(OTHER)).toBe(false);
    });

    it("refuses a remote with no GitHub identity, and grants nothing", () => {
      store.add(URL);
      expect(store.setAllowAgentMerge("https://gitlab.com/owner/repo", false)).toBe("no-identity");
      expect(store.setAllowAgentMerge("not a url", true)).toBe("no-identity");
      expect(store.allowsAgentMerge("https://gitlab.com/owner/repo")).toBe(false);
      // A near-miss host must never inherit the grant.
      store.setAllowAgentMerge(URL, true);
      expect(store.allowsAgentMerge("https://github.com.evil.example/owner/repo")).toBe(false);
    });

    it("an unknown remote is not granted", () => {
      expect(store.allowsAgentMerge("https://github.com/never/added.git")).toBe(false);
    });

    it("says WHY nothing was written — no identity, or no such repository", () => {
      // The two failures are not the same answer, and reporting "ok" for the
      // second granted a repository ShipIt does not hold: the write matched
      // zero rows, the route answered 200, and adding that repository later
      // started it with the grant OFF (cross-agent review finding).
      store.add(URL);
      expect(store.setAllowAgentMerge("https://gitlab.com/owner/repo", true)).toBe("no-identity");
      expect(store.setAllowAgentMerge("https://github.com/never/added.git", true)).toBe("not-found");
      expect(store.setAllowAgentMerge(URL, true)).toBe("ok");
      // …and the untracked one really did write nothing, so adding it now
      // starts from the default.
      const added = store.add("https://github.com/never/added.git");
      expect(added.allowAgentMerge).toBe(false);
    });

    it("is read from the row, not cached on the store instance", () => {
      store.add(URL);
      store.setAllowAgentMerge(URL, true);
      // Same connection — this proves only that a second store sees it, which
      // is a weaker claim than durability. The next test makes that one.
      const reopened = new RepoStore(dbManager);
      expect(reopened.allowsAgentMerge(URL)).toBe(true);
    });

    it("survives closing and reopening the database file", () => {
      // The durability claim, on a real file: the grant is a permission, and a
      // migration that ran but did not persist the column — or a value held
      // only in memory — would silently revoke it on the next restart. Reopening
      // also re-runs the migrations over a populated database.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-store-grant-"));
      const file = path.join(dir, "shipit.db");
      try {
        const first = new DatabaseManager(file);
        const firstStore = new RepoStore(first);
        firstStore.add(URL);
        expect(firstStore.setAllowAgentMerge(URL, true)).toBe("ok");
        first.close();

        const second = new DatabaseManager(file);
        try {
          expect(new RepoStore(second).allowsAgentMerge(URL)).toBe(true);
        } finally {
          second.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("trust (docs/178)", () => {
    const URL = "https://github.com/owner/repo.git";

    it("a freshly-added repo is untrusted by default", () => {
      const repo = store.add(URL);
      expect(repo.trusted).toBe(false);
      expect(store.isTrusted(URL)).toBe(false);
    });

    it("setTrusted flips the flag and isTrusted reflects it", () => {
      store.add(URL);
      store.setTrusted(URL, true);
      expect(store.isTrusted(URL)).toBe(true);
      expect(store.get(URL)?.trusted).toBe(true);
      store.setTrusted(URL, false);
      expect(store.isTrusted(URL)).toBe(false);
      expect(store.get(URL)?.trusted).toBe(false);
    });

    it("trust is keyed by canonical repo identity, not the raw URL", () => {
      // Stored with the .git suffix; trusted via the suffix-less form. The
      // .git suffix, a trailing slash, and host casing all collapse to the
      // same canonical key. (scp-style SSH is a genuinely distinct key under
      // canonicalRepoKey, so it is intentionally not asserted equal here.)
      store.add(URL);
      store.setTrusted("https://github.com/owner/repo", true);
      expect(store.isTrusted(URL)).toBe(true);
      expect(store.isTrusted("https://github.com/owner/repo")).toBe(true);
      expect(store.isTrusted("https://GitHub.com/owner/repo.git/")).toBe(true);
    });

    it("trust is per-remote — trusting one does not trust another", () => {
      const OTHER = "https://github.com/other/thing.git";
      store.add(URL);
      store.add(OTHER);
      store.setTrusted(URL, true);
      expect(store.isTrusted(URL)).toBe(true);
      expect(store.isTrusted(OTHER)).toBe(false);
    });

    it("an unknown remote is untrusted", () => {
      expect(store.isTrusted("https://github.com/never/added.git")).toBe(false);
    });

    it("trust persists across store instances", () => {
      store.add(URL);
      store.setTrusted(URL, true);
      const store2 = new RepoStore(dbManager);
      expect(store2.isTrusted(URL)).toBe(true);
    });
  });

  describe("hidden (docs/222)", () => {
    const URL = "https://github.com/owner/repo.git";

    it("a freshly-added repo is visible by default", () => {
      const repo = store.add(URL);
      expect(repo.hidden).toBe(false);
    });

    it("setHidden flips the flag and get reflects it", () => {
      store.add(URL);
      expect(store.setHidden(URL, true)).toBe(true);
      expect(store.get(URL)?.hidden).toBe(true);
      expect(store.setHidden(URL, false)).toBe(true);
      expect(store.get(URL)?.hidden).toBe(false);
    });

    it("setHidden returns false for an unknown repo", () => {
      expect(store.setHidden("https://github.com/never/added.git", true)).toBe(false);
    });

    it("re-adding a hidden repo unhides it", () => {
      store.add(URL);
      store.setHidden(URL, true);
      expect(store.get(URL)?.hidden).toBe(true);
      const readded = store.add(URL);
      expect(readded.hidden).toBe(false);
      expect(store.get(URL)?.hidden).toBe(false);
      // Still a single row — re-add dedups, it doesn't duplicate.
      expect(store.list()).toHaveLength(1);
    });

    it("hidden state persists across store instances", () => {
      store.add(URL);
      store.setHidden(URL, true);
      const store2 = new RepoStore(dbManager);
      expect(store2.get(URL)?.hidden).toBe(true);
    });

    it("hiding does not affect other repos", () => {
      const OTHER = "https://github.com/other/thing.git";
      store.add(URL);
      store.add(OTHER);
      store.setHidden(URL, true);
      expect(store.get(URL)?.hidden).toBe(true);
      expect(store.get(OTHER)?.hidden).toBe(false);
    });
  });

  describe("setOrder", () => {
    it("orders repos by display_order when set", () => {
      store.add("https://github.com/a/repo.git");
      store.add("https://github.com/b/repo.git");
      store.add("https://github.com/c/repo.git");
      // Default order is lastUsedAt desc — c, b, a.
      // Reverse to a, b, c.
      store.setOrder([
        "https://github.com/a/repo.git",
        "https://github.com/b/repo.git",
        "https://github.com/c/repo.git",
      ]);
      const list = store.list();
      expect(list.map((r) => r.url)).toEqual([
        "https://github.com/a/repo.git",
        "https://github.com/b/repo.git",
        "https://github.com/c/repo.git",
      ]);
    });

    it("repos with NULL display_order sort after those with one", () => {
      store.add("https://github.com/a/repo.git");
      store.add("https://github.com/b/repo.git");
      store.add("https://github.com/c/repo.git");
      // Only set order for c — a and b should come after by lastUsedAt desc.
      store.setOrder(["https://github.com/c/repo.git"]);
      const list = store.list();
      expect(list[0].url).toBe("https://github.com/c/repo.git");
      // Then b (more recent) before a.
      expect(list[1].url).toBe("https://github.com/b/repo.git");
      expect(list[2].url).toBe("https://github.com/a/repo.git");
    });

    it("ignores unknown urls without throwing", () => {
      store.add("https://github.com/a/repo.git");
      store.setOrder([
        "https://github.com/unknown/repo.git",
        "https://github.com/a/repo.git",
      ]);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].url).toBe("https://github.com/a/repo.git");
    });

    it("can reorder repeatedly", () => {
      store.add("https://github.com/a/repo.git");
      store.add("https://github.com/b/repo.git");
      store.setOrder([
        "https://github.com/a/repo.git",
        "https://github.com/b/repo.git",
      ]);
      expect(store.list().map((r) => r.url)).toEqual([
        "https://github.com/a/repo.git",
        "https://github.com/b/repo.git",
      ]);
      store.setOrder([
        "https://github.com/b/repo.git",
        "https://github.com/a/repo.git",
      ]);
      expect(store.list().map((r) => r.url)).toEqual([
        "https://github.com/b/repo.git",
        "https://github.com/a/repo.git",
      ]);
    });

    it("persists order across store instances", () => {
      store.add("https://github.com/a/repo.git");
      store.add("https://github.com/b/repo.git");
      store.setOrder([
        "https://github.com/a/repo.git",
        "https://github.com/b/repo.git",
      ]);
      const store2 = new RepoStore(dbManager);
      expect(store2.list().map((r) => r.url)).toEqual([
        "https://github.com/a/repo.git",
        "https://github.com/b/repo.git",
      ]);
    });
  });

  describe("defaultBranch", () => {
    const url = "https://github.com/owner/repo.git";

    it("is undefined until resolved, so callers fall back to main", () => {
      store.add(url);
      expect(store.get(url)?.defaultBranch).toBeUndefined();
    });

    it("round-trips a non-main default branch", () => {
      store.add(url);
      expect(store.setDefaultBranch(url, "master")).toBe(true);
      expect(store.get(url)?.defaultBranch).toBe("master");
      expect(store.list()[0].defaultBranch).toBe("master");
    });

    it("reports no update for an unknown repo", () => {
      expect(store.setDefaultBranch("https://github.com/nope/nope.git", "trunk")).toBe(false);
    });

    it("survives a store re-open (persisted, not in-memory)", () => {
      store.add(url);
      store.setDefaultBranch(url, "trunk");
      expect(new RepoStore(dbManager).get(url)?.defaultBranch).toBe("trunk");
    });
  });

  // docs/254 — per-repo identity color for the sidebar's group edge.
  describe("colorIndex", () => {
    const a = "https://github.com/owner/a.git";
    const b = "https://github.com/owner/b.git";

    it("assigns a color on add", () => {
      expect(store.add(a).colorIndex).toBe(REPO_COLOR_ASSIGNMENT_ORDER[0]);
    });

    // req 5 — no two repos share a color while unused colors remain.
    it("gives each new repo a distinct color", () => {
      const urls = Array.from({ length: 16 }, (_, i) => `https://github.com/owner/r${i}.git`);
      const assigned = urls.map((u) => store.add(u).colorIndex);
      expect(new Set(assigned).size).toBe(16);
    });

    // req 6 — stable across re-add, which is how unhiding works (add() clears
    // `hidden`), so a repo coming back out of the Hidden section keeps its color.
    it("does not reassign on re-add", () => {
      store.add(a);
      store.setColorIndex(a, 7);
      store.add(b);
      expect(store.add(a).colorIndex).toBe(7);
    });

    it("does not hand a second repo the colour a hidden repo is holding", () => {
      store.add(a);
      store.setHidden(a, true);
      // `a` still holds its color while hidden; `b` must not collide with it, or
      // unhiding `a` would produce two identical edges.
      expect(store.add(b).colorIndex).toBe(REPO_COLOR_ASSIGNMENT_ORDER[1]);
    });

    it("sets and persists an explicit color", () => {
      store.add(a);
      expect(store.setColorIndex(a, 11)).toBe(true);
      expect(new RepoStore(dbManager).get(a)?.colorIndex).toBe(11);
    });

    it("reports no update for an unknown repo", () => {
      expect(store.setColorIndex("https://github.com/nope/nope.git", 3)).toBe(false);
    });

    it("reuses a freed color after a removal", () => {
      store.add(a);            // assignment order [0]
      store.add(b);            // assignment order [1]
      store.remove(a);
      expect(store.add("https://github.com/owner/c.git").colorIndex).toBe(REPO_COLOR_ASSIGNMENT_ORDER[0]);
    });
  });
});
