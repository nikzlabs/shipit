import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chownToSessionWorker, sessionWorkerUid } from "./session-worker-uid.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { APPLIED, applyFailed, applyPartial } from "../shared/settings-catalogue/index.js";
import type { ApplyOutcome } from "../shared/settings-catalogue/index.js";

// Creation modes do not repair files or directories from older installations.
function tightenMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    console.warn(
      `[git-config] could not tighten mode on ${target}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface GitIdentity {
  name: string;
  email: string;
}

// Repair persistent grants from older builds; merely stopping writes would leave them active.
function removeSafeDirectoryGrant(): void {
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "--unset-all", "safe.directory"]), {
      stdio: "ignore",
    });
  } catch {
    // Absent key or unavailable git.
  }
}

// Avoid .git-credentials, which git's credential-store helper may discover automatically.
export const GLOBAL_CREDENTIAL_FILENAME = ".git-credential-github";
const MIN_PLAUSIBLE_GITHUB_TOKEN_LENGTH = 20;

function globalCredentialFilePath(): string {
  const configPath = process.env.GIT_CONFIG_GLOBAL;
  return path.join(configPath ? path.dirname(configPath) : "/credentials", GLOBAL_CREDENTIAL_FILENAME);
}

// Keep the token root-owned; only the token-free config is shared with the worker UID.
function writeRootOnlyCredentialFile(target: string, token: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o711 });
  fs.writeFileSync(target, `username=x-access-token\npassword=${token}\n`, { mode: 0o600 });
  tightenMode(target, 0o600);
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function initGlobalGitConfig(credentialsDir: string): void {
  // Dropped-UID git must traverse to .gitconfig without being able to list credentials.
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o711 });
  tightenMode(credentialsDir, 0o711);
  const configPath = path.join(credentialsDir, ".gitconfig");
  process.env.GIT_CONFIG_GLOBAL = configPath;

  migrateLegacyIdentity(credentialsDir);

  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "commit.gpgsign", "false"]));
  } catch {
    // git may not be installed yet.
  }

  removeSafeDirectoryGrant();

  // The orchestrator has no SSH keys; HTTPS uses its credential helper.
  const GITHUB_HTTPS_INSTEAD_OF = "url.https://github.com/.insteadOf";
  for (const [from, valueRegex] of [
    ["git@github.com:", "^git@github\\.com:$"],
    ["ssh://git@github.com/", "^ssh://git@github\\.com/$"],
  ] as const) {
    try {
      execFileSync("git", gitArgsWithHooksDisabled([
        "config", "--global", "--replace-all", GITHUB_HTTPS_INSTEAD_OF, from, valueRegex,
      ]));
    } catch {
      // git may not be installed yet.
    }
  }

  pinHomeDefaultFiles(credentialsDir);
  shareGlobalGitConfigWithWorker(credentialsDir);

  if (!process.env.GIT_EDITOR) {
    process.env.GIT_EDITOR = "true";
  }

  pinGitMessageLocale();
}

// Stderr classifiers require English. Called separately when GIT_CONFIG_GLOBAL bypasses init.
export function pinGitMessageLocale(): void {
  const previous = process.env.LC_ALL;
  if (previous !== undefined && previous !== "C") {
    console.log(
      `[git-config] overriding LC_ALL=${previous} with C — ShipIt matches git's English `
      + "stderr to detect workspace content it cannot read (docs/266-orchestrator-git-trust-boundary reqs 14, 15)",
    );
  }
  process.env.LC_ALL = "C";
}

export const CONTAINER_CREDENTIAL_HELPER = "/usr/local/bin/shipit-git-credential";

export const FALLBACK_CONTAINER_GIT_IDENTITY: GitIdentity = {
  name: "ShipIt Agent",
  email: "agent@shipit.invalid",
};

function reshareGlobalGitConfig(): void {
  const configPath = process.env.GIT_CONFIG_GLOBAL;
  if (!configPath) return;
  shareGlobalGitConfigWithWorker(path.dirname(configPath));
}

// With GIT_CONFIG_GLOBAL set, these two defaults are the only files git reads
// under $HOME. Dropped-UID git cannot reach /root, and each EACCES warning led
// the stderr of a real failure, so a rebase notice read as a permissions problem.
const HOME_DEFAULT_FILES = [
  ["core.excludesFile", "gitignore-global"],
  ["core.attributesFile", "gitattributes-global"],
] as const;

function pinHomeDefaultFiles(credentialsDir: string): void {
  if (sessionWorkerUid() === null) return;
  for (const [key, filename] of HOME_DEFAULT_FILES) pinGlobalFile(credentialsDir, key, filename);
}

function pinGlobalFile(credentialsDir: string, key: string, filename: string): void {
  try {
    const existing = execFileSync(
      "git",
      gitArgsWithHooksDisabled(["config", "--global", key]),
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (existing) return;
  } catch {
    // Unset key.
  }
  const target = path.join(credentialsDir, filename);
  try {
    // Preserve operator entries across restarts.
    if (!fs.existsSync(target)) fs.writeFileSync(target, "", { mode: 0o644 });
    tightenMode(target, 0o644);
    // Root-side git reads it too, so the worker must not be able to edit it.
    restoreRootOwnership(target);
  } catch (err) {
    console.warn(
      `[git-config] could not create the ${key} file at ${target}:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", key, target]));
  } catch {
    // git may not be installed yet.
  }
}

function shareGlobalGitConfigWithWorker(credentialsDir: string): void {
  if (sessionWorkerUid() === null) return;
  const configPath = path.join(credentialsDir, ".gitconfig");
  if (!fs.existsSync(configPath)) return;
  tightenMode(configPath, 0o644);
  restoreRootOwnership(configPath);
}

// Root also executes helpers from this config, so worker writability would permit root execution.
// git config replaces the inode: restore ownership after writes.
function restoreRootOwnership(target: string): void {
  if (process.getuid?.() !== 0) return;
  try {
    fs.lchownSync(target, 0, 0);
  } catch (err) {
    console.warn(
      `[git-config] could not restore root ownership of ${target}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function writeContainerGitConfig(destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Remove any stale token-bearing config before rebuilding.
  fs.writeFileSync(destPath, "", { mode: 0o600 });

  const set = (key: string, value: string): void => {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--file", destPath, key, value]));
  };

  // Keep the fallback container-only; global identity drives the user's identity prompt.
  const id = getGitIdentity() ?? FALLBACK_CONTAINER_GIT_IDENTITY;
  set("user.name", id.name);
  set("user.email", id.email);
  set("commit.gpgsign", "false");
  set("credential.helper", CONTAINER_CREDENTIAL_HELPER);

  chownToSessionWorker(destPath);
}

/**
 * The two fields **as git answered for them**, empty where the key is not set;
 * `ok: false` means ShipIt could not tell. `git config --global <key>` is what
 * makes the two hard to separate: an unset key and an unreadable config file
 * both exit **1**, so the exit status alone cannot answer it
 * (docs/299-agent-settings-access req 1). Measured against git 2.x: unset exits
 * 1 with nothing on stderr, an unreadable config exits 1 with
 * `warning: unable to access`, a malformed one exits 128, and a missing git
 * binary never runs at all.
 *
 * A HALF-set identity keeps both halves rather than collapsing to "none": a
 * caller reporting the value would otherwise say the name is unset when it is
 * not, and a caller hashing it for staleness would give every half-set state the
 * same revision — so changing the name under an unset email would read as no
 * change at all.
 */
export type GitIdentityRead =
  | { ok: true; identity: GitIdentity }
  | { ok: false; error: unknown };

type ConfigValueRead =
  | { ok: true; value: string }
  /** `unset` separates "git answered, the key is not there" from every failure. */
  | { ok: false; unset: boolean; error: unknown };

function globalConfigValue(key: string): ConfigValueRead {
  try {
    const value = execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", key]), {
      encoding: "utf-8",
    });
    return { ok: true, value: value.trim() };
  } catch (err) {
    const failure = err as { status?: number | null; stderr?: string | Buffer | null };
    const stderr = typeof failure.stderr === "string"
      ? failure.stderr
      : failure.stderr?.toString("utf-8") ?? "";
    return { ok: false, unset: failure.status === 1 && stderr.trim() === "", error: err };
  }
}

export function readGitIdentity(): GitIdentityRead {
  const name = globalConfigValue("user.name");
  if (!name.ok && !name.unset) return { ok: false, error: name.error };
  const email = globalConfigValue("user.email");
  if (!email.ok && !email.unset) return { ok: false, error: email.error };
  return {
    ok: true,
    identity: { name: name.ok ? name.value : "", email: email.ok ? email.value : "" },
  };
}

/**
 * The identity ShipIt can actually commit with, for callers that act the same
 * way on a missing half and on one they could not read — the container fallback
 * and the "set your git identity" prompt. A caller that REPORTS the value wants
 * {@link readGitIdentity}, which keeps those apart.
 */
export function getGitIdentity(): GitIdentity | null {
  const read = readGitIdentity();
  if (!read.ok) return null;
  const { name, email } = read.identity;
  // A key set to an empty string counts as unset, as it always has.
  return name && email ? { name, email } : null;
}

/**
 * Two writes, so three outcomes. A failure on the name is a verified `failed` —
 * nothing ran. A failure on the email after the name landed is `partial`, and
 * says which half: `git config` cannot prove a rollback would succeed either, so
 * claiming "nothing changed" there would be the false report docs/299 ("Saved"
 * has to mean saved) exists to remove.
 */
export function setGitIdentity(name: string, email: string): ApplyOutcome {
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "user.name", name]));
  } catch (err) {
    console.error("[git-config] setting user.name failed:", err);
    return applyFailed("ShipIt could not write the git user name, so neither half of the identity changed.");
  }
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "user.email", email]));
  } catch (err) {
    console.error("[git-config] setting user.email failed:", err);
    return applyPartial("The git user name was saved, but ShipIt could not write the email address.");
  }
  return APPLIED;
}

export function setGlobalCredentialHelper(token: string): void {
  if (!token.trim()) {
    throw new Error("setGlobalCredentialHelper: refusing to install an empty GitHub credential");
  }
  // Warn without rejecting potential future token formats.
  if (token.trim().length < MIN_PLAUSIBLE_GITHUB_TOKEN_LENGTH) {
    console.warn(
      `[git-config] installing a GitHub credential of ${token.trim().length} characters — too short `
        + "for any GitHub token format, so git will fail with \"Invalid username or token\"",
    );
  }
  const credentialPath = globalCredentialFilePath();
  writeRootOnlyCredentialFile(credentialPath, token);
  // Missing is a fault; unreadable is expected for dropped-UID git, which uses a repo-scoped helper.
  const quoted = singleQuote(credentialPath);
  const helper = `!f() { [ -e ${quoted} ] || { echo "shipit: git credential file missing at ${credentialPath}" >&2; return 1; }; cat ${quoted} 2>/dev/null; }; f`;
  execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "credential.helper", helper]));
  reshareGlobalGitConfig();
}

export function clearGlobalCredentialHelper(): void {
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "--unset", "credential.helper"]));
  } catch {
    // Already unset.
  }
  try {
    fs.rmSync(globalCredentialFilePath(), { force: true });
  } catch (err) {
    console.warn(
      "[git-config] could not remove the global credential file:",
      err instanceof Error ? err.message : String(err),
    );
  }
  reshareGlobalGitConfig();
}

function migrateLegacyIdentity(credentialsDir: string): void {
  if (getGitIdentity()) return;

  try {
    const credsFile = path.join(credentialsDir, "shipit-credentials.json");
    const raw = fs.readFileSync(credsFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const id = data.gitIdentity as Record<string, unknown> | undefined;
    if (
      id &&
      typeof id.name === "string" &&
      id.name.trim() &&
      typeof id.email === "string" &&
      id.email.trim()
    ) {
      setGitIdentity(id.name.trim(), id.email.trim());
      console.log("[git-config] Migrated identity from credential store:", id.name);
    }
  } catch {
    // No credentials file or parse error.
  }
}
