import { describe, it, expect } from "vitest";
import {
  getShipitSourceStatus,
  listShipitSourceTree,
  searchShipitSource,
  catShipitSource,
  logShipitSource,
  blameShipitSource,
  showShipitSource,
  filterRedactedDiff,
  isRedactedSourcePath,
  resolveShipitFixTarget,
  ensureShipitSourceRepoReady,
  buildShipitFixPrompt,
  type ShipitSourceDeps,
} from "./shipit-source.js";
import { ServiceError } from "./types.js";

/**
 * A scriptable fake `git` that maps `args.join(" ")` → stdout, or throws when
 * the key maps to an Error. Lets us exercise the source service without a real
 * checkout.
 */
function fakeGit(map: Record<string, string | Error>): ShipitSourceDeps["runGit"] {
  return async (_dir, args) => {
    const key = args.join(" ");
    const val = map[key];
    if (val instanceof Error) throw val;
    if (val === undefined) {
      const err = new Error(`no fake for: ${key}`) as Error & { code?: number };
      err.code = 128;
      throw err;
    }
    return val;
  };
}

const BUILD_SHA = "abc123def4567890abc123def4567890abc12345";

function depsWithBuildId(map: Record<string, string | Error>): ShipitSourceDeps {
  return {
    env: { SHIPIT_BUILD_ID: BUILD_SHA, SHIPIT_SOURCE_DIR: "/src" },
    runGit: fakeGit(map),
  };
}

describe("isRedactedSourcePath", () => {
  it("redacts secret artifacts but not source files", () => {
    expect(isRedactedSourcePath(".env")).toBe(true);
    expect(isRedactedSourcePath("app/.env.local")).toBe(true);
    expect(isRedactedSourcePath("certs/server.pem")).toBe(true);
    expect(isRedactedSourcePath("deploy/key.p12")).toBe(true);
    expect(isRedactedSourcePath(".git/config")).toBe(true);
    expect(isRedactedSourcePath("home/.netrc")).toBe(true);
    expect(isRedactedSourcePath("id_rsa")).toBe(true);

    // Source files that merely mention "credential"/"env" must stay readable.
    expect(isRedactedSourcePath("src/server/orchestrator/credential-store.ts")).toBe(false);
    expect(isRedactedSourcePath("src/server/env-config.ts")).toBe(false);
    expect(isRedactedSourcePath("README.md")).toBe(false);
  });
});

describe("getShipitSourceStatus", () => {
  it("reports the exact deployed commit when SHIPIT_BUILD_ID exists in the checkout", async () => {
    const status = await getShipitSourceStatus(
      depsWithBuildId({
        "rev-parse --is-inside-work-tree": "true\n",
        [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
        "remote get-url origin": "https://github.com/acme/shipit.git\n",
      }),
    );
    expect(status.available).toBe(true);
    expect(status.exact).toBe(true);
    expect(status.ref).toBe(BUILD_SHA);
    expect(status.shortRef).toBe(BUILD_SHA.slice(0, 12));
    expect(status.refSource).toBe("build-id");
    expect(status.remoteUrl).toBe("https://github.com/acme/shipit.git");
  });

  it("falls back to checkout HEAD (approximate) when the build commit is absent", async () => {
    const headSha = "0000111122223333444455556666777788889999";
    const status = await getShipitSourceStatus(
      depsWithBuildId({
        "rev-parse --is-inside-work-tree": "true\n",
        [`cat-file -e ${BUILD_SHA}^{commit}`]: new Error("not found"),
        "rev-parse HEAD": `${headSha}\n`,
        "remote get-url origin": "git@github.com:acme/shipit.git\n",
      }),
    );
    expect(status.available).toBe(true);
    expect(status.exact).toBe(false);
    expect(status.ref).toBe(headSha);
    expect(status.refSource).toBe("checkout-head");
  });

  it("reports unavailable when there is no git checkout", async () => {
    const status = await getShipitSourceStatus({
      env: { SHIPIT_SOURCE_DIR: "/nope" },
      runGit: fakeGit({ "rev-parse --is-inside-work-tree": new Error("not a repo") }),
    });
    expect(status.available).toBe(false);
    expect(status.exact).toBe(false);
    expect(status.reason).toMatch(/unavailable/i);
  });

  it("strips embedded credentials from the origin remote URL", async () => {
    const status = await getShipitSourceStatus(
      depsWithBuildId({
        "rev-parse --is-inside-work-tree": "true\n",
        [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
        "remote get-url origin":
          "https://x-access-token:github_pat_SECRET123@github.com/acme/shipit.git\n",
      }),
    );
    expect(status.remoteUrl).toBe("https://github.com/acme/shipit.git");
    // The PAT must never survive into the displayed/stored status.
    expect(JSON.stringify(status)).not.toContain("github_pat_SECRET123");
  });

  it("honors SHIPIT_SOURCE_REPO_URL over the origin remote", async () => {
    const status = await getShipitSourceStatus({
      env: {
        SHIPIT_BUILD_ID: BUILD_SHA,
        SHIPIT_SOURCE_DIR: "/src",
        SHIPIT_SOURCE_REPO_URL: "https://github.com/override/repo.git",
      },
      runGit: fakeGit({
        "rev-parse --is-inside-work-tree": "true\n",
        [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
      }),
    });
    expect(status.remoteUrl).toBe("https://github.com/override/repo.git");
  });
});

describe("listShipitSourceTree", () => {
  const base = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };

  it("lists directory entries and filters redacted paths, dirs first", async () => {
    const lsOut =
      `040000 tree aaa\tsrc/server\n` +
      `100644 blob bbb\tsrc/index.ts\n` +
      `100644 blob ccc\tsrc/.env.local\n`;
    const result = await listShipitSourceTree("src", depsWithBuildId({
      ...base,
      [`ls-tree --full-tree ${BUILD_SHA} src/`]: lsOut,
    }));
    expect(result.ref).toBe(BUILD_SHA);
    expect(result.entries).toEqual([
      { name: "server", type: "dir" },
      { name: "index.ts", type: "file" },
    ]);
  });

  it("rejects paths containing ..", async () => {
    await expect(listShipitSourceTree("../etc", depsWithBuildId(base))).rejects.toBeInstanceOf(ServiceError);
  });

  it("503s when the source is unavailable", async () => {
    await expect(
      listShipitSourceTree("src", {
        runGit: fakeGit({ "rev-parse --is-inside-work-tree": new Error("nope") }),
        env: {},
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("searchShipitSource", () => {
  const base = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };

  it("parses git grep output and skips redacted files", async () => {
    const grepOut =
      `${BUILD_SHA}:src/a.ts:12:const Foo = 1\n` +
      `${BUILD_SHA}:.env:3:SECRET=Foo\n`;
    const result = await searchShipitSource("Foo", undefined, depsWithBuildId({
      ...base,
      [`grep -n -I -e Foo ${BUILD_SHA}`]: grepOut,
    }));
    expect(result.matches).toEqual([{ path: "src/a.ts", line: 12, text: "const Foo = 1" }]);
  });

  it("returns an empty result when git grep finds nothing (exit 1)", async () => {
    const noMatch = Object.assign(new Error(""), { code: 1, stderr: "" });
    const result = await searchShipitSource("Nope", undefined, depsWithBuildId({
      ...base,
      [`grep -n -I -e Nope ${BUILD_SHA}`]: noMatch,
    }));
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("requires a query", async () => {
    await expect(searchShipitSource("  ", undefined, depsWithBuildId(base))).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("catShipitSource", () => {
  const base = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };

  it("returns file content at the snapshot ref", async () => {
    const result = await catShipitSource("src/index.ts", depsWithBuildId({
      ...base,
      [`show ${BUILD_SHA}:src/index.ts`]: "export const x = 1;\n",
    }));
    expect(result.content).toBe("export const x = 1;\n");
    expect(result.ref).toBe(BUILD_SHA);
    expect(result.truncated).toBe(false);
  });

  it("refuses to read a redacted path before touching git", async () => {
    await expect(catShipitSource(".env", depsWithBuildId(base))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("404s on a missing file", async () => {
    const missing = Object.assign(new Error("fatal: path does not exist"), { stderr: "fatal: path does not exist" });
    await expect(
      catShipitSource("src/missing.ts", depsWithBuildId({
        ...base,
        [`show ${BUILD_SHA}:src/missing.ts`]: missing,
      })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("logShipitSource", () => {
  const base = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };
  const SHA2 = "1111222233334444555566667777888899990000";

  it("parses NUL-delimited commit records", async () => {
    const out =
      `${BUILD_SHA}\x00Alice\x002026-01-02T03:04:05Z\x00Fix the bug\x1e\n` +
      `${SHA2}\x00Bob\x002026-01-01T00:00:00Z\x00Earlier: change\x1e\n`;
    const result = await logShipitSource(undefined, {}, depsWithBuildId({
      ...base,
      [`log --max-count=21 --format=%H%x00%an%x00%aI%x00%s%x1e ${BUILD_SHA}`]: out,
    }));
    expect(result.commits).toEqual([
      { hash: BUILD_SHA, shortHash: BUILD_SHA.slice(0, 12), author: "Alice", date: "2026-01-02T03:04:05Z", subject: "Fix the bug" },
      { hash: SHA2, shortHash: SHA2.slice(0, 12), author: "Bob", date: "2026-01-01T00:00:00Z", subject: "Earlier: change" },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("flags truncation when more than `limit` commits come back", async () => {
    const rec = (h: string) => `${h}\x00A\x002026\x00s\x1e\n`;
    const result = await logShipitSource(undefined, { limit: 1 }, depsWithBuildId({
      ...base,
      [`log --max-count=2 --format=%H%x00%an%x00%aI%x00%s%x1e ${BUILD_SHA}`]: rec(BUILD_SHA) + rec(SHA2),
    }));
    expect(result.commits.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("scopes to a path and rejects redacted paths", async () => {
    const result = await logShipitSource("src", {}, depsWithBuildId({
      ...base,
      [`log --max-count=21 --format=%H%x00%an%x00%aI%x00%s%x1e ${BUILD_SHA} -- src`]: `${BUILD_SHA}\x00A\x002026\x00s\x1e\n`,
    }));
    expect(result.path).toBe("src");
    expect(result.commits.length).toBe(1);
    await expect(logShipitSource(".env", {}, depsWithBuildId(base))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("blameShipitSource", () => {
  const base = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };
  const SHA2 = "1111222233334444555566667777888899990000";

  it("parses line-porcelain into per-line attribution", async () => {
    const porcelain =
      `${BUILD_SHA} 1 1 1\n` +
      `author Alice\n` +
      `author-time 100\n` +
      `\texport const x = 1;\n` +
      `${SHA2} 2 2\n` +
      `author Bob\n` +
      `author-time 200\n` +
      `\texport const y = 2;\n`;
    const result = await blameShipitSource("src/index.ts", depsWithBuildId({
      ...base,
      [`blame --line-porcelain ${BUILD_SHA} -- src/index.ts`]: porcelain,
    }));
    expect(result.lines).toEqual([
      { line: 1, shortHash: BUILD_SHA.slice(0, 12), author: "Alice", text: "export const x = 1;" },
      { line: 2, shortHash: SHA2.slice(0, 12), author: "Bob", text: "export const y = 2;" },
    ]);
  });

  it("refuses a redacted path before touching git", async () => {
    await expect(blameShipitSource(".env", depsWithBuildId(base))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("showShipitSource", () => {
  const base = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };

  it("returns commit metadata + diff, hiding redacted file diffs", async () => {
    const showOut =
      `commit abc123\nAuthor: A\n\n    msg\n\n` +
      `diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n` +
      `diff --git a/.env b/.env\n@@ -1 +1 @@\n-SECRET=old\n+SECRET=new\n`;
    const result = await showShipitSource("abc123", undefined, depsWithBuildId({
      ...base,
      "show --no-color abc123": showOut,
    }));
    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("SECRET=new");
    expect(result.content).toMatch(/file diff\(s\) hidden/);
  });

  it("rejects an invalid commit-ish", async () => {
    await expect(showShipitSource("--upload-pack=evil", undefined, depsWithBuildId(base)))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("scopes to a path when given, rejecting redacted paths", async () => {
    const result = await showShipitSource("abc123", "src/a.ts", depsWithBuildId({
      ...base,
      "show --no-color abc123 -- src/a.ts": "diff --git a/src/a.ts b/src/a.ts\n+new\n",
    }));
    expect(result.content).toContain("src/a.ts");
    await expect(showShipitSource("abc123", ".env", depsWithBuildId(base)))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("filterRedactedDiff", () => {
  it("drops redacted file sections and keeps the header + safe diffs", () => {
    const out = filterRedactedDiff(
      `commit X\n\ndiff --git a/src/ok.ts b/src/ok.ts\n+ok\n` +
        `diff --git a/secrets/key.pem b/secrets/key.pem\n+PRIVATE\n`,
    );
    expect(out).toContain("commit X");
    expect(out).toContain("src/ok.ts");
    expect(out).not.toContain("PRIVATE");
    expect(out).toContain("1 file diff(s) hidden");
  });

  it("returns metadata-only output unchanged when there is no diff", () => {
    expect(filterRedactedDiff("commit X\nAuthor: A\n\n    msg\n")).toBe("commit X\nAuthor: A\n\n    msg\n");
  });
});

describe("resolveShipitFixTarget", () => {
  const exactBase = {
    "rev-parse --is-inside-work-tree": "true\n",
    [`cat-file -e ${BUILD_SHA}^{commit}`]: "",
    "remote get-url origin": "https://github.com/acme/shipit.git\n",
  };

  it("returns the exact ref + repo URL for an exact source", async () => {
    const target = await resolveShipitFixTarget(false, depsWithBuildId(exactBase));
    expect(target).toEqual({
      ref: BUILD_SHA,
      exact: true,
      repoUrl: "https://github.com/acme/shipit.git",
      refSource: "build-id",
    });
  });

  it("rejects an approximate source unless --approximate is passed", async () => {
    const headSha = "1111222233334444555566667777888899990000";
    const approxDeps: ShipitSourceDeps = {
      env: { SHIPIT_BUILD_ID: BUILD_SHA, SHIPIT_SOURCE_DIR: "/src" },
      runGit: fakeGit({
        "rev-parse --is-inside-work-tree": "true\n",
        [`cat-file -e ${BUILD_SHA}^{commit}`]: new Error("absent"),
        "rev-parse HEAD": `${headSha}\n`,
        "remote get-url origin": "https://github.com/acme/shipit.git\n",
      }),
    };
    await expect(resolveShipitFixTarget(false, approxDeps)).rejects.toMatchObject({ statusCode: 400 });
    const target = await resolveShipitFixTarget(true, approxDeps);
    expect(target.ref).toBe(headSha);
    expect(target.exact).toBe(false);
  });

  it("throws when the source is unavailable", async () => {
    await expect(
      resolveShipitFixTarget(true, { env: {}, runGit: fakeGit({ "rev-parse --is-inside-work-tree": new Error("no") }) }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("ensureShipitSourceRepoReady", () => {
  it("is a no-op when the repo is already ready", async () => {
    let cloned = false;
    const key = await ensureShipitSourceRepoReady("https://github.com/acme/shipit.git", {
      repoStore: {
        get: () => ({ status: "ready" }),
        add: () => { throw new Error("should not add"); },
        setReady: () => { throw new Error("should not setReady"); },
        list: () => [],
      },
      getSharedRepoDir: (u) => `/cache/${u}`,
      ensureBareCache: async () => { cloned = true; },
    });
    expect(cloned).toBe(false);
    expect(key).toBe("https://github.com/acme/shipit.git");
  });

  it("registers, clones, and marks the repo ready when missing", async () => {
    const events: string[] = [];
    const key = await ensureShipitSourceRepoReady("https://github.com/acme/shipit.git", {
      repoStore: {
        get: () => undefined,
        add: () => events.push("add"),
        setReady: () => events.push("setReady"),
        list: () => [],
      },
      getSharedRepoDir: () => "/cache/shipit",
      ensureBareCache: async (dir) => { events.push(`clone:${dir}`); },
    });
    expect(events).toEqual(["add", "clone:/cache/shipit", "setReady"]);
    expect(key).toBe("https://github.com/acme/shipit.git");
  });

  it("reuses the user's existing entry instead of adding a duplicate for a credentialed URL", async () => {
    // The user already added the clean URL via the home screen; the host
    // checkout's origin carries an embedded PAT (and the same repo, different
    // casing / `.git`). The credentialed URL must resolve to the SAME entry.
    const userUrl = "https://github.com/acme/shipit.git";
    const store = new Map<string, { status: string }>([[userUrl, { status: "ready" }]]);
    const added: string[] = [];
    const key = await ensureShipitSourceRepoReady(
      "https://x-access-token:github_pat_ABC123@GitHub.com/acme/shipit",
      {
        repoStore: {
          get: (u) => store.get(u),
          add: (u) => { added.push(u); store.set(u, { status: "cloning" }); return undefined; },
          setReady: () => { throw new Error("should not setReady"); },
          list: () => [...store.keys()].map((url) => ({ url })),
        },
        getSharedRepoDir: (u) => `/cache/${u}`,
        ensureBareCache: async () => { throw new Error("should not clone — already ready"); },
      },
    );
    expect(added).toEqual([]); // no duplicate add
    expect(key).toBe(userUrl); // reuses the user's clean entry verbatim
  });

  it("registers a credential-free key (never the embedded PAT) when no entry exists", async () => {
    const store = new Map<string, { status: string }>();
    const added: string[] = [];
    const clonedFrom: string[] = [];
    const key = await ensureShipitSourceRepoReady(
      "https://x-access-token:github_pat_SECRET@github.com/acme/shipit.git",
      {
        repoStore: {
          get: (u) => store.get(u),
          add: (u) => { added.push(u); store.set(u, { status: "cloning" }); return undefined; },
          setReady: (u) => { store.set(u, { status: "ready" }); },
          list: () => [...store.keys()].map((url) => ({ url })),
        },
        getSharedRepoDir: (u) => `/cache/${u}`,
        ensureBareCache: async (_dir, u) => { clonedFrom.push(u); },
      },
    );
    expect(key).toBe("https://github.com/acme/shipit.git");
    expect(added).toEqual(["https://github.com/acme/shipit.git"]);
    // Nothing the store/cache ever sees may contain the PAT.
    expect(JSON.stringify({ key, added, clonedFrom })).not.toContain("github_pat_SECRET");
  });
});

describe("buildShipitFixPrompt", () => {
  it("includes the exact ref, parent linkage, and constraints", () => {
    const prompt = buildShipitFixPrompt({
      ref: "abc123",
      exact: true,
      parentSessionId: "ses_ops",
      diagnosis: "The container recreate loop is caused by X.",
    });
    expect(prompt).toContain("Source ref: abc123 (exact deployed commit)");
    expect(prompt).toContain("Spawned by Ops session: ses_ops");
    expect(prompt).toContain("The container recreate loop is caused by X.");
    expect(prompt).toContain("## Constraints");
  });

  it("marks an approximate ref clearly", () => {
    const prompt = buildShipitFixPrompt({ ref: "def", exact: false, parentSessionId: "ses_ops", diagnosis: "d" });
    expect(prompt).toContain("APPROXIMATE");
  });
});
