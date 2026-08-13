/**
 * docs/262 req 10 — the credential ShipIt fetches a plugin repository with,
 * under BOTH credential modes, and the named failure when neither mode can
 * reach it (req 13).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other orchestrator-side git operation rides ONE credential: the global
 * helper `git-config.ts` installs, which echoes the host PAT for any repository
 * the orchestrator touches. That is exactly wrong for a plugin repository under
 * GitHub App mode, and the reason is the whole point of req 10: **a plugin
 * repository is a different repository from the project the session is on.**
 * An App mints tokens per *installation*, so the token that clones the project
 * says nothing about — and does not work on — the plugin repository. Left on the
 * global helper, an App-only install would fetch a private plugin repository
 * with no usable credential at all and report a bare `fatal: Authentication
 * failed`.
 *
 * So the fetch resolves its own credential, for the plugin repository's own
 * `owner/repo`:
 *
 *   1. **A read-only App installation token**, when a GitHub App is configured.
 *      Read-only is req 7 made structural: a declaration is a standing grant to
 *      *fetch*, never to push, so the credential ShipIt mints for it cannot push
 *      (`contents: read` — see `github-app-token.ts`).
 *   2. **The host PAT**, when the App is not configured, or is not installed on
 *      this repository, or minting failed. Availability over tightness, the same
 *      policy `getRepoScopedGitCredential` already applies to the session's own
 *      repository: the App is the enhancement, the PAT is the operator's
 *      configured credential.
 *   3. **No credential** — which is not an error. A public plugin repository is
 *      fetchable by a ShipIt with no GitHub identity at all, and refusing to try
 *      would break that.
 *
 * All of it runs ORCHESTRATOR-side (req 19): a fetch credential is resolved,
 * used, and dropped here, and never enters a session container, a generation, or
 * anything a plugin declares. The token is passed to git through the child
 * process ENVIRONMENT (see `GitRemoteCredential` in `repo-git.ts`) rather than
 * an `https://user:token@host` remote or a `-c` config value, so it lands in
 * neither the bare cache's config nor the process's argv.
 *
 * Authorization stays **one-time per installation** (req 10): the App
 * installation or the PAT's scope is the whole of it. Nothing is stored per
 * project, and no project-local secret exists to keep in sync — which is also
 * why this deliberately does NOT read the consuming project's secret store
 * (req 23's credentials are the plugin's own third-party keys, a different
 * thing entirely, and req 23 forbids that store resolving ShipIt's platform
 * credentials).
 */

import { ensureBareCache, type GitRemoteCredential, type RepoGit } from "./repo-git.js";
import { isGitAuthError } from "./git-utils.js";
import type { AppTokenMintFailure, AppTokenMintResult } from "./github-app-token.js";

/** A plugin repository, as the declaration names it. */
export interface PluginRepoSource {
  owner: string;
  repo: string;
}

/** The slice of `GitHubAuthManager` this module needs; narrow, so tests can fake it. */
export interface PluginFetchAuthority {
  appTokensEnabled(): boolean;
  mintReadOnlyRepoToken(owner: string, repo: string): Promise<AppTokenMintResult>;
  getToken(): string | null;
}

/** Which credential mode actually answered. */
export type PluginFetchMode = "app" | "pat" | "none";

/** The resolved fetch credential, plus what it took to get there. */
export interface PluginFetchCredential {
  mode: PluginFetchMode;
  credential?: GitRemoteCredential;
  /**
   * Why the App path produced nothing, when an App was configured. Kept even
   * when the PAT then answered, because it is the fact that names the failure
   * if the fetch fails anyway (req 13).
   */
  appFailure?: AppTokenMintFailure;
}

/**
 * The username git wants beside a GitHub token — the same one every other
 * credential path in this repo uses.
 */
const TOKEN_USERNAME = "x-access-token";

/**
 * The only origin a plugin repository can live on in v1, and the only origin
 * the resolved credential is ever offered to (`gitCredentialConfig`). GitHub is
 * also the only host ShipIt holds a token for — handing it to another one is
 * an exfiltration channel, the same reasoning `getGitCredential` states.
 */
const GITHUB_ORIGIN = "https://github.com";

/**
 * Parse `https://github.com/owner/repo.git` into its parts. Returns null for
 * anything else; the caller then fetches with the host credential and reports a
 * plain failure, because a source it cannot name is a source it cannot mint for.
 */
export function parseGitHubRepoUrl(repoUrl: string): PluginRepoSource | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Resolve the credential for ONE plugin repository. Never throws: a mint that
 * fails is a fallback, not an error.
 *
 * A `null` source — a clone URL this module cannot name an `owner/repo` for —
 * resolves to no credential at all. There is nothing to mint for, and a token
 * offered to a host we did not recognize is the leak `gitCredentialConfig`'s
 * host scoping exists to prevent; git then falls back to whatever the
 * orchestrator's global config provides, which is what this path did before.
 */
export async function resolvePluginFetchCredential(
  authority: PluginFetchAuthority,
  source: PluginRepoSource | null,
): Promise<PluginFetchCredential> {
  if (!source) return { mode: "none" };
  let appFailure: AppTokenMintFailure | undefined;
  if (authority.appTokensEnabled()) {
    const minted = await authority.mintReadOnlyRepoToken(source.owner, source.repo);
    if (minted.ok) {
      return {
        mode: "app",
        credential: { origin: GITHUB_ORIGIN, token: { username: TOKEN_USERNAME, password: minted.token } },
      };
    }
    appFailure = minted.reason;
  }
  const pat = authority.getToken();
  if (pat) {
    return {
      mode: "pat",
      credential: { origin: GITHUB_ORIGIN, token: { username: TOKEN_USERNAME, password: pat } },
      ...(appFailure ? { appFailure } : {}),
    };
  }
  // No credential, but still a credential DECISION: the fetch runs with the
  // inherited helpers reset and prompts disabled, so "ShipIt has no credential
  // for this repository" cannot be quietly answered by a stale global helper,
  // and a private repository fails fast and classifiably instead of stalling on
  // a prompt (review finding).
  return { mode: "none", credential: { origin: GITHUB_ORIGIN }, ...(appFailure ? { appFailure } : {}) };
}

/**
 * Does this git failure look like "you may not read this repository"?
 *
 * Deliberately wider than `isGitAuthError`, which was written for a token that
 * used to work and stopped. The failures this path produces are mostly the other
 * shape: GitHub answers **404 "Repository not found"** for a private repository
 * the credential cannot see — it will not confirm the repository exists — and
 * git with no credential at all and `GIT_TERMINAL_PROMPT=0` fails at the prompt.
 */
export function isRepoAccessFailure(err: unknown): boolean {
  if (isGitAuthError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /repository not found/i.test(msg)
    || /could not read Username/i.test(msg)
    || /terminal prompts disabled/i.test(msg)
    || /access denied/i.test(msg)
    || /remote:\s*Not Found/i.test(msg)
    || /\bHTTP\s+(401|403|404)\b/i.test(msg)
    // git over libcurl reports a refusal as `The requested URL returned error:
    // 403` — no "HTTP", no "Forbidden", so every other clause here misses it,
    // and a genuine authorization failure stayed opaque (review finding).
    || /requested URL returned error:\s*(401|403|404)/i.test(msg)
  );
}

/**
 * Turn a failed plugin fetch into a message that names the repository, the
 * credential mode that was tried, and the one-time act that would fix it
 * (req 13 — "not reachable with your current GitHub setup" beats an opaque
 * fetch failure).
 *
 * Returns the original error unchanged when the failure is not credential-
 * shaped: a DNS outage must not be reported as a permissions problem.
 */
export function describePluginFetchFailure(
  source: PluginRepoSource | null,
  resolved: PluginFetchCredential,
  err: unknown,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (!source || !isRepoAccessFailure(err)) return original;

  const where = `${source.owner}/${source.repo}`;
  // The sentence every branch needs: authorizing the project says nothing about
  // the plugin repository, and that is the whole of req 10's second mode.
  const different = `A plugin repository is a different repository from this project, so authorizing the project does not cover ${where}.`;

  // GitHub answers 404 for "the App is not installed here" and for "no such
  // repository" alike — it will not confirm a repository the caller cannot see.
  // So this says both (review finding): telling someone to install the App when
  // they actually mistyped the name sends them to fix something that is not
  // broken.
  const appNote = resolved.appFailure === "not_installed"
    ? `ShipIt's GitHub App cannot see ${where} — either it is not installed on that repository, or no such repository exists`
    : resolved.appFailure
      ? `ShipIt could not mint a GitHub App token for ${where}`
      : null;

  // The token remedy depends on which kind of PAT is configured, and this repo
  // already distinguishes them elsewhere (`github-auth.ts`'s fine-grained
  // handling), so naming only the classic scope would send half of the users
  // the wrong way (review finding).
  const grantToken = `Check the repository name, then grant the host token access to ${where} — a classic token needs the \`repo\` scope; a fine-grained token needs ${where} among its selected repositories with read access to Contents.`;

  let detail: string;
  if (resolved.mode === "app") {
    // A token was minted, so the App IS installed — the installation just does
    // not grant reading this repository's contents.
    detail = `ShipIt's GitHub App token for ${where} was refused. Check that the installation still covers that repository and grants read access to its contents.`;
  } else if (resolved.mode === "pat" && appNote) {
    detail = `${appNote}, and the host GitHub token cannot read it either. Install the App on ${where}, or ${lowerFirst(grantToken)}`;
  } else if (resolved.mode === "pat") {
    detail = `The host GitHub token cannot read ${where}. ${grantToken}`;
  } else if (appNote) {
    detail = `${appNote}, and this ShipIt has no GitHub token to fall back on. Check the repository name, install the App on ${where}, or connect GitHub.`;
  } else {
    detail = `This ShipIt has no GitHub credential, so it can only fetch public repositories. Connect GitHub, or install ShipIt's GitHub App on ${where}.`;
  }

  const gitLine = original.message.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  const trailer = gitLine ? ` (git: ${gitLine})` : "";
  return new Error(`${where} is not reachable with your current GitHub setup. ${detail} ${different}${trailer}`);
}

/** Fold a sentence into the middle of another one. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export interface PluginRepoFetcherDeps {
  authority: PluginFetchAuthority;
  /** The shared bare-cache factory, credential-aware (`app-di.ts`). */
  createRepoGit: (dir: string, credential?: GitRemoteCredential) => RepoGit;
}

/**
 * Build the `ensureCache` hook `activateDeclaredPlugins` injects: bring one
 * plugin repository's bare cache up to date, with that repository's own
 * credential.
 *
 * TTL 0 on the fetch, matching what this path did before: activation resolves a
 * tracked branch to its tip, so serving it from a minute-old cache would
 * activate a stale commit (req 12's refresh would appear to do nothing).
 */
export function createPluginRepoFetcher(
  deps: PluginRepoFetcherDeps,
): (cacheDir: string, repoUrl: string) => Promise<void> {
  return async (cacheDir: string, repoUrl: string): Promise<void> => {
    const source = parseGitHubRepoUrl(repoUrl);
    const resolved = await resolvePluginFetchCredential(deps.authority, source);
    try {
      const { git } = await ensureBareCache(cacheDir, repoUrl, deps.createRepoGit, resolved.credential);
      await git.fetchCache(0);
    } catch (err) {
      throw describePluginFetchFailure(source, resolved, err);
    }
  };
}
