import type { SimpleGit, SimpleGitOptions } from "simple-git";
import { safeSimpleGit } from "./git-hooks-guard.js";

export interface GitRemoteCredential {
  origin: string;
  /** Omitted clears inherited helpers without supplying a replacement credential. */
  token?: { username: string; password: string };
  /** A declared LFS host that is not the remote's (docs/320-lfs-host-credential). */
  lfsHost?: LfsHostCredential;
  /** Why a declared LFS host got no credential; reported by the operation that needed it. */
  lfsHostRefusal?: string;
}

export interface LfsHostCredential {
  /** `https://<host>[:port]`, the only origin the credential is offered to. */
  origin: string;
  username: string;
  password: string;
}

/** `host` is the declared host a refusal is about, so it is reported only where that host was asked for. */
export type LfsHostResolution = { credential: LfsHostCredential } | { refusal: string; host?: string };

// The repository behind a tree comes from ShipIt: a provisioning caller names it, or
// the resolver finds ShipIt's record. Never from the tree's editable `origin`.
export type LfsHostCredentialResolver = (dir: string, repoUrl?: string) => Promise<LfsHostResolution | null>;

// Registered once at boot, beside the SecretStore it reads.
let lfsHostCredentialResolver: LfsHostCredentialResolver | undefined;

export function configureLfsHostCredentialResolver(resolve: LfsHostCredentialResolver | undefined): void {
  lfsHostCredentialResolver = resolve;
}

const CREDENTIAL_ENV_USERNAME = "SHIPIT_GIT_CRED_USERNAME";
const CREDENTIAL_ENV_PASSWORD = "SHIPIT_GIT_CRED_PASSWORD";
const LFS_CREDENTIAL_ENV_USERNAME = "SHIPIT_LFS_CRED_USERNAME";
const LFS_CREDENTIAL_ENV_PASSWORD = "SHIPIT_LFS_CRED_PASSWORD";
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/;

// Keep intentional GIT_CONFIG_GLOBAL and GIT_EDITOR; scrub other executable overrides.
const UNSAFE_GIT_ENV = [
  "PAGER", "GIT_PAGER",
  "GIT_ASKPASS", "SSH_ASKPASS",
  "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEMPLATE_DIR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
];

export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of UNSAFE_GIT_ENV) Reflect.deleteProperty(out, key);
  for (const key of Object.keys(out)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) Reflect.deleteProperty(out, key);
  }
  return out;
}

// Both config builders validate independently: origin becomes part of a config key.
function assertSafeOrigin(origin: string): void {
  if (!SAFE_ORIGIN.test(origin)) throw new Error(`Refusing to build a git credential helper for origin "${origin}"`);
}

function envHelper(usernameVar: string, passwordVar: string): string {
  return `!f() { echo "username=$${usernameVar}"; echo "password=$${passwordVar}"; }; f`;
}

export function gitCredentialConfig(credential: GitRemoteCredential): string[] {
  const { origin, lfsHost } = credential;
  assertSafeOrigin(origin);
  // Reset the multi-valued helper list before adding origin-scoped helpers.
  // Only variable names enter argv; the secrets stay in the child environment.
  const config = ["credential.helper="];
  if (credential.token) {
    config.push(`credential.${origin}.helper=${envHelper(CREDENTIAL_ENV_USERNAME, CREDENTIAL_ENV_PASSWORD)}`);
  }
  if (lfsHost) {
    assertSafeOrigin(lfsHost.origin);
    config.push(
      `credential.${lfsHost.origin}.helper=${envHelper(LFS_CREDENTIAL_ENV_USERNAME, LFS_CREDENTIAL_ENV_PASSWORD)}`,
    );
  }
  return config;
}

export function gitCredentialSpawnOverrides(
  credential: GitRemoteCredential | null,
): { args: string[]; env: Record<string, string> } {
  if (!credential) return { args: [], env: {} };
  return {
    args: gitCredentialConfig(credential).flatMap((entry) => ["-c", entry]),
    env: gitCredentialEnv(credential),
  };
}

// Apply after sanitizeGitEnv. extraHeader authenticates the first request;
// helpers alone wait for a 401. Environment config keeps secrets out of argv and files.
export function gitCredentialEnv(credential: GitRemoteCredential): Record<string, string> {
  const env: Record<string, string> = {};
  // The LFS host gets no preemptive header: git-lfs asks the helper after its first 401.
  if (credential.lfsHost) {
    assertSafeOrigin(credential.lfsHost.origin);
    env[LFS_CREDENTIAL_ENV_USERNAME] = credential.lfsHost.username;
    env[LFS_CREDENTIAL_ENV_PASSWORD] = credential.lfsHost.password;
    env.GIT_TRACE_REDACT = "1";
  }
  if (!credential.token) return env;
  assertSafeOrigin(credential.origin);
  const { username, password } = credential.token;
  const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return {
    ...env,
    [CREDENTIAL_ENV_USERNAME]: username,
    [CREDENTIAL_ENV_PASSWORD]: password,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${credential.origin}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    // Preserve curl tracing without allowing it to write the credential verbatim.
    GIT_TRACE_REDACT: "1",
  };
}

const AUTH_REJECTED = /invalid username or token|authentication failed|could not read username|\b401\b/i;

export function looksLikeAuthRejection(text: string): boolean {
  return AUTH_REJECTED.test(text);
}

// For fetch/clone/ls-remote, a public repo may still work with a refused credential.
// Never use for push: anonymous receive-pack cannot succeed.
export async function withPreemptiveAuthFallback<T>(
  credential: GitRemoteCredential | null,
  what: string,
  run: (credential: GitRemoteCredential | null) => Promise<T>,
  /** Classifies returned failures; thrown failures are matched by message. */
  rejected?: (value: T) => boolean,
): Promise<T> {
  if (!credential?.token) return run(credential);
  try {
    const result = await run(credential);
    if (!rejected?.(result)) return result;
    warnRetryingUnauthenticated(what, credential.origin);
    return await run(withoutRemoteToken(credential));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!AUTH_REJECTED.test(message)) throw err;
    warnRetryingUnauthenticated(what, credential.origin);
    return run(withoutRemoteToken(credential));
  }
}

// The anonymous retry drops the remote's token, not a declared LFS host's credential.
function withoutRemoteToken(credential: GitRemoteCredential): GitRemoteCredential | null {
  const { lfsHost, lfsHostRefusal } = credential;
  if (!lfsHost && !lfsHostRefusal) return null;
  return { origin: credential.origin, ...(lfsHost ? { lfsHost } : {}), ...(lfsHostRefusal ? { lfsHostRefusal } : {}) };
}

// A ref push or fetch never talks to the LFS host, so it does not carry its secret.
export function withoutLfsHost(credential: GitRemoteCredential | null): GitRemoteCredential | null {
  if (!credential?.token) return null;
  return { origin: credential.origin, token: credential.token };
}

function warnRetryingUnauthenticated(what: string, origin: string): void {
  console.warn(
    `[git] ${what}: ${origin} refused the credential ShipIt holds, so this operation is being `
    + "retried unauthenticated — which is how it ran before docs/288-preemptive-github-auth. If it "
    + "now succeeds, the credential is stale or scoped to another repository, and every "
    + "authenticated operation (pushes included) is already failing.",
  );
}

// Mirror git-config.ts: getRemotes returns URLs before git applies these rewrites.
const GITHUB_SSH_REWRITES: readonly (readonly [string, string])[] = [
  ["git@github.com:", "https://github.com/"],
  ["ssh://git@github.com/", "https://github.com/"],
];

function applyGithubSshRewrite(url: string): string {
  for (const [from, to] of GITHUB_SSH_REWRITES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

export interface RemoteOrigin {
  origin: string;
  host: string;
  owner?: string;
  repo?: string;
}

export function parseRemoteOrigin(url: string | undefined): RemoteOrigin | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(applyGithubSshRewrite(url.trim()));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!SAFE_ORIGIN.test(origin)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return { origin, host: parsed.hostname };
  return {
    origin,
    host: parsed.hostname,
    owner: segments[0],
    repo: segments[1].replace(/\.git$/, ""),
  };
}

export type GitRemoteCredentialResolver = (
  remote: RemoteOrigin,
) => Promise<{ username: string; password: string } | null>;

export async function resolveLfsHost(dir: string, repoUrl?: string): Promise<LfsHostResolution | null> {
  if (!lfsHostCredentialResolver) return null;
  try {
    return await lfsHostCredentialResolver(dir, repoUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { refusal: `ShipIt could not read the declared LFS host credential: ${message}` };
  }
}

// Resolution failures preserve the inherited git path instead of aborting the operation.
// `lfsHost` asks for a declared LFS host's credential too; only LFS transfers need it.
// `repoUrl` is for a caller provisioning a tree ShipIt has not recorded yet.
export async function resolveTreeRemoteCredential(
  dir: string,
  remote: string,
  resolve: GitRemoteCredentialResolver | undefined,
  readRemoteUrl?: () => Promise<string | undefined>,
  opts?: { lfsHost?: boolean; repoUrl?: string },
): Promise<GitRemoteCredential | null> {
  const wantsLfs = opts?.lfsHost === true && lfsHostCredentialResolver !== undefined;
  if (!resolve && !wantsLfs) return null;

  let url: string | undefined;
  try {
    url = readRemoteUrl ? await readRemoteUrl() : await defaultReadRemoteUrl(dir, remote);
  } catch {
    return null;
  }
  const origin = parseRemoteOrigin(url);
  const lfs = wantsLfs ? await resolveLfsHost(dir, opts?.repoUrl) : null;
  const lfsFields = !lfs
    ? {}
    : "credential" in lfs ? { lfsHost: lfs.credential } : { lfsHostRefusal: lfs.refusal };

  let token: { username: string; password: string } | null = null;
  if (origin && resolve) {
    try {
      token = await resolve(origin);
    } catch (err) {
      console.warn(
        `[git] resolving a remote credential for ${origin.origin} failed; `
        + "falling back to the inherited helpers:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (token && origin) return { origin: origin.origin, token, ...lfsFields };
  // No remote token, but a declared LFS host: still reset inherited helpers, so a helper
  // written into the workspace config cannot answer for that host (req 8).
  const lfsOrigin = !lfs ? undefined : "credential" in lfs ? lfs.credential.origin : lfs.host && `https://${lfs.host}`;
  if (lfsOrigin) return { origin: origin?.origin ?? lfsOrigin, ...lfsFields };
  return null;
}

async function defaultReadRemoteUrl(dir: string, remote: string): Promise<string | undefined> {
  const remotes = await safeSimpleGit(dir).getRemotes(true);
  const match = remotes.find((r) => r.name === remote);
  return match?.refs.push || match?.refs.fetch || undefined;
}

// Do not chain .env() on the returned instance: it would erase the credential
// while leaving the argv helper reset in force.
export function credentialledGit(
  dir: string,
  credential: GitRemoteCredential,
  options?: Partial<SimpleGitOptions>,
): SimpleGit {
  return safeSimpleGit(dir, {
    ...options,
    config: [...(options?.config ?? []), ...gitCredentialConfig(credential)],
    unsafe: {
      ...options?.unsafe,
      allowUnsafeConfigPaths: true,
      allowUnsafeEditor: true,
      allowUnsafeCredentialHelper: true,
      // Safe only with inherited config scrubbed before our pair is added below.
      allowUnsafeConfigEnvCount: true,
    },
  }).env({
    ...sanitizeGitEnv(process.env),
    ...gitCredentialEnv(credential),
    GIT_TERMINAL_PROMPT: "0",
  });
}
