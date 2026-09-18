import { ensureBareCache, type GitRemoteCredential, type RepoGit } from "./repo-git.js";
import { isGitAuthError } from "./git-utils.js";
import type { AppTokenMintFailure, AppTokenMintResult } from "./github-app-token.js";

export interface PluginRepoSource {
  owner: string;
  repo: string;
}

export interface PluginFetchAuthority {
  appTokensEnabled(): boolean;
  mintReadOnlyRepoToken(owner: string, repo: string): Promise<AppTokenMintResult>;
  getToken(): string | null;
}

export type PluginFetchMode = "app" | "pat" | "none";

export interface PluginFetchCredential {
  mode: PluginFetchMode;
  credential?: GitRemoteCredential;
  appFailure?: AppTokenMintFailure;
}

const TOKEN_USERNAME = "x-access-token";
const GITHUB_ORIGIN = "https://github.com";

export function parseGitHubRepoUrl(repoUrl: string): PluginRepoSource | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// The project's App installation does not authorize a different plugin repository.
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
  // An explicit empty credential resets inherited helpers and disables prompts.
  return { mode: "none", credential: { origin: GITHUB_ORIGIN }, ...(appFailure ? { appFailure } : {}) };
}

// GitHub hides inaccessible private repositories behind 404 responses.
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
    || /requested URL returned error:\s*(401|403|404)/i.test(msg)
  );
}

export function describePluginFetchFailure(
  source: PluginRepoSource | null,
  resolved: PluginFetchCredential,
  err: unknown,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (!source || !isRepoAccessFailure(err)) return original;

  const where = `${source.owner}/${source.repo}`;
  const different = `A plugin repository is a different repository from this project, so authorizing the project does not cover ${where}.`;

  const appNote = resolved.appFailure === "not_installed"
    ? `ShipIt's GitHub App cannot see ${where} — either it is not installed on that repository, or no such repository exists`
    : resolved.appFailure
      ? `ShipIt could not mint a GitHub App token for ${where}`
      : null;

  const grantToken = `Check the repository name, then grant the host token access to ${where} — a classic token needs the \`repo\` scope; a fine-grained token needs ${where} among its selected repositories with read access to Contents.`;

  let detail: string;
  if (resolved.mode === "app") {
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

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export interface PluginRepoFetcherDeps {
  authority: PluginFetchAuthority;
  createRepoGit: (dir: string, credential?: GitRemoteCredential) => RepoGit;
}

export function createPluginRepoFetcher(
  deps: PluginRepoFetcherDeps,
): (cacheDir: string, repoUrl: string) => Promise<void> {
  return async (cacheDir: string, repoUrl: string): Promise<void> => {
    const source = parseGitHubRepoUrl(repoUrl);
    const resolved = await resolvePluginFetchCredential(deps.authority, source);
    try {
      const { git } = await ensureBareCache(cacheDir, repoUrl, deps.createRepoGit, resolved.credential);
      // Activation must resolve the current branch tip, not a cached commit.
      await git.fetchCache(0);
    } catch (err) {
      throw describePluginFetchFailure(source, resolved, err);
    }
  };
}
