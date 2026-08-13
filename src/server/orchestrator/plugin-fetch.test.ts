/**
 * docs/262 req 10 — a plugin repository is fetched with ITS OWN credential,
 * under both credential modes, and req 13 — when neither mode reaches it, the
 * failure names the repository and the one-time act that fixes it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createPluginRepoFetcher,
  describePluginFetchFailure,
  isRepoAccessFailure,
  parseGitHubRepoUrl,
  resolvePluginFetchCredential,
  type PluginFetchAuthority,
} from "./plugin-fetch.js";
import { RepoGit, type GitRemoteCredential } from "./repo-git.js";
import type { AppTokenMintResult } from "./github-app-token.js";

/** A fake `GitHubAuthManager` slice: what the host has configured. */
function authority(opts: {
  app?: AppTokenMintResult;
  pat?: string | null;
  onMint?: (owner: string, repo: string) => void;
}): PluginFetchAuthority {
  return {
    appTokensEnabled: () => opts.app !== undefined,
    mintReadOnlyRepoToken: async (owner, repo) => {
      opts.onMint?.(owner, repo);
      return opts.app ?? { ok: false, reason: "not_configured" };
    },
    getToken: () => opts.pat ?? null,
  };
}

describe("parseGitHubRepoUrl", () => {
  it("names owner and repo for the URLs the declaration builds", () => {
    expect(parseGitHubRepoUrl("https://github.com/acme/tools.git")).toEqual({ owner: "acme", repo: "tools" });
    expect(parseGitHubRepoUrl("https://github.com/acme/tools")).toEqual({ owner: "acme", repo: "tools" });
  });

  it("returns null for anything it cannot name a repository in", () => {
    expect(parseGitHubRepoUrl("https://gitlab.com/acme/tools.git")).toBeNull();
    expect(parseGitHubRepoUrl("git@github.com:acme/tools.git")).toBeNull();
    expect(parseGitHubRepoUrl("https://github.com/acme")).toBeNull();
  });
});

describe("resolvePluginFetchCredential", () => {
  const source = { owner: "acme", repo: "tools" };

  it("mints an App token for the PLUGIN repository, not the project", async () => {
    const minted: string[] = [];
    const resolved = await resolvePluginFetchCredential(
      authority({
        app: { ok: true, token: "ghs_ro" },
        pat: "ghp_host",
        onMint: (o, r) => minted.push(`${o}/${r}`),
      }),
      source,
    );
    expect(minted).toEqual(["acme/tools"]);
    expect(resolved.mode).toBe("app");
    expect(resolved.credential).toEqual({
      origin: "https://github.com",
      username: "x-access-token",
      password: "ghs_ro",
    });
  });

  it("falls back to the host PAT when the App is not installed, and remembers why", async () => {
    const resolved = await resolvePluginFetchCredential(
      authority({ app: { ok: false, reason: "not_installed" }, pat: "ghp_host" }),
      source,
    );
    expect(resolved.mode).toBe("pat");
    expect(resolved.credential?.password).toBe("ghp_host");
    // Kept even though the PAT answered: it is what names the failure if the
    // fetch fails anyway.
    expect(resolved.appFailure).toBe("not_installed");
  });

  it("uses the PAT directly when no App is configured", async () => {
    const resolved = await resolvePluginFetchCredential(authority({ pat: "ghp_host" }), source);
    expect(resolved.mode).toBe("pat");
    expect(resolved.appFailure).toBeUndefined();
  });

  it("resolves to no credential when the host has none — a public repository still fetches", async () => {
    const resolved = await resolvePluginFetchCredential(authority({ pat: null }), source);
    expect(resolved).toEqual({ mode: "none" });
  });

  it("mints nothing for a URL it cannot name a repository in", async () => {
    const minted: string[] = [];
    const resolved = await resolvePluginFetchCredential(
      authority({ app: { ok: true, token: "ghs_ro" }, pat: "ghp_host", onMint: (o, r) => minted.push(`${o}/${r}`) }),
      null,
    );
    // No token is offered to a host we did not recognize.
    expect(resolved).toEqual({ mode: "none" });
    expect(minted).toEqual([]);
  });
});

describe("isRepoAccessFailure", () => {
  it("recognizes the shapes a refused GitHub fetch actually takes", () => {
    expect(isRepoAccessFailure(new Error("remote: Repository not found."))).toBe(true);
    expect(isRepoAccessFailure(new Error("fatal: Authentication failed for 'https://github.com/a/b.git'"))).toBe(true);
    expect(isRepoAccessFailure(new Error("could not read Username for 'https://github.com'"))).toBe(true);
    expect(isRepoAccessFailure(new Error("terminal prompts disabled"))).toBe(true);
  });

  it("does not claim an outage is a permissions problem", () => {
    expect(isRepoAccessFailure(new Error("Could not resolve host: github.com"))).toBe(false);
    expect(isRepoAccessFailure(new Error("early EOF"))).toBe(false);
  });
});

describe("describePluginFetchFailure", () => {
  const source = { owner: "acme", repo: "tools" };
  const refused = new Error("remote: Repository not found.\nfatal: repository not found");

  it("names the App as the missing authorization, and says the project is not enough", () => {
    const msg = describePluginFetchFailure(
      source,
      { mode: "pat", appFailure: "not_installed", credential: {} as GitRemoteCredential },
      refused,
    ).message;
    expect(msg).toContain("acme/tools");
    expect(msg).toContain("GitHub App is not installed on acme/tools");
    expect(msg).toContain("different repository from this project");
    // The git line is kept for debuggability.
    expect(msg).toContain("git:");
  });

  it("names the token when there is no App at all", () => {
    const msg = describePluginFetchFailure(source, { mode: "pat" }, refused).message;
    expect(msg).toContain("host GitHub token cannot read acme/tools");
    expect(msg).toContain("`repo` scope");
  });

  it("says a minted token was refused when the App IS installed", () => {
    const msg = describePluginFetchFailure(source, { mode: "app" }, refused).message;
    expect(msg).toContain("GitHub App token for acme/tools was refused");
  });

  it("says there is no credential at all when the host has none", () => {
    const msg = describePluginFetchFailure(source, { mode: "none" }, refused).message;
    expect(msg).toContain("no GitHub credential");
    expect(msg).toContain("only fetch public repositories");
  });

  it("leaves a non-credential failure exactly as it was", () => {
    const outage = new Error("fatal: unable to access: Could not resolve host: github.com");
    expect(describePluginFetchFailure(source, { mode: "pat" }, outage)).toBe(outage);
  });

  it("leaves any failure alone when the repository could not be named", () => {
    expect(describePluginFetchFailure(null, { mode: "pat" }, refused)).toBe(refused);
  });
});

describe("createPluginRepoFetcher", () => {
  it("hands the resolved credential to the bare-cache factory and fetches with ttl 0", async () => {
    const seen: (GitRemoteCredential | undefined)[] = [];
    let fetchedTtl: number | undefined;
    const fetcher = createPluginRepoFetcher({
      authority: authority({ app: { ok: true, token: "ghs_ro" } }),
      createRepoGit: (dir, credential) => {
        seen.push(credential);
        return {
          repoDir: dir,
          cloneBare: async () => undefined,
          fetchCache: async (ttl: number) => { fetchedTtl = ttl; },
        } as unknown as RepoGit;
      },
    });

    // A cache directory that already looks healthy, so `ensureBareCache` takes
    // its fast path rather than re-cloning.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-fetch-test-"));
    try {
      fs.writeFileSync(path.join(tmp, "HEAD"), "ref: refs/heads/main\n");
      await fetcher(tmp, "https://github.com/acme/tools.git");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(seen).toEqual([{ origin: "https://github.com", username: "x-access-token", password: "ghs_ro" }]);
    // A tracked branch is resolved to its tip; a minute-old cache would
    // activate a stale commit and make refresh look like a no-op.
    expect(fetchedTtl).toBe(0);
  });

  it("reports a refused fetch by name (req 13)", async () => {
    const fetcher = createPluginRepoFetcher({
      authority: authority({ app: { ok: false, reason: "not_installed" }, pat: "ghp_host" }),
      createRepoGit: (dir) => ({
        repoDir: dir,
        fetchCache: async () => { throw new Error("remote: Repository not found."); },
      } as unknown as RepoGit),
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-fetch-test-"));
    try {
      fs.writeFileSync(path.join(tmp, "HEAD"), "ref: refs/heads/main\n");
      await expect(fetcher(tmp, "https://github.com/acme/tools.git")).rejects.toThrow(
        /GitHub App is not installed on acme\/tools/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches a repository the host has no credential for at all", async () => {
    // The public-plugin-repository case: no App, no PAT, and it must still work.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-fetch-test-"));
    try {
      const seedDir = path.join(tmp, "seed");
      fs.mkdirSync(seedDir, { recursive: true });
      execSync("git init -b main", { cwd: seedDir, stdio: "ignore" });
      execSync("git config user.email t@example.com && git config user.name T", { cwd: seedDir, stdio: "ignore" });
      fs.writeFileSync(path.join(seedDir, "README.md"), "# plugin\n");
      execSync("git add . && git commit -m init --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });

      const fetcher = createPluginRepoFetcher({
        authority: authority({ pat: null }),
        createRepoGit: (dir, credential) => new RepoGit(dir, credential),
      });
      const cacheDir = path.join(tmp, "cache");
      fs.mkdirSync(cacheDir, { recursive: true });
      await fetcher(cacheDir, `file://${seedDir}`);

      expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
