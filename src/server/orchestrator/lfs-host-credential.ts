// docs/320-lfs-host-credential: a ShipIt-held credential for a declared Git LFS host.
import fs from "node:fs";
import path from "node:path";
import {
  type LfsHostConfig,
  parseShipitConfigText,
  resolveShipitConfig,
} from "../shared/shipit-config.js";
import type { LfsHostCredentialResolver, LfsHostResolution } from "../shared/git-remote-credential.js";
import { PROBE_TIMEOUT_MS } from "./git-lfs.js";
import { runGit } from "../shared/run-git.js";
import { resolveCacheFetchRef } from "./git-lfs-store.js";

// The host lives inside the secret, so editing shipit.yaml can never redirect it (req 4).
export function parseLfsHostSecret(value: string, declared: LfsHostConfig): LfsHostResolution {
  const refuse = (refusal: string): LfsHostResolution => ({ refusal, host: declared.host });
  const name = `the secret \`${declared.credential}\``;
  const format = "https://<username>:<password>@<host>";
  // URL would silently drop a line break, so a two-line value would read as one.
  if (/\p{Cc}/u.test(value.trim())) {
    return refuse(`${name} must be one line (${format}), with no control characters.`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return refuse(`${name} is not a credential line of the form ${format}.`);
  }
  if (url.protocol !== "https:") {
    return refuse(`${name} must be an https:// line (${format}); ShipIt does not send it over ${url.protocol}//.`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return refuse(`${name} must name only a host (${format}), with no path.`);
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return refuse(`${name} has a username or password that is not valid percent-encoding.`);
  }
  // A decoded line break would add lines to the credential helper's answer.
  if (/\p{Cc}/u.test(username + password)) {
    return refuse(`${name} has a control character in its username or password.`);
  }
  if (!username || !password) {
    return refuse(`${name} needs both a username and a password (${format}).`);
  }
  const host = url.host.toLowerCase();
  if (host !== declared.host) {
    return refuse(
      `${name} is for \`${host}\`, but shipit.yaml declares \`lfs.host: ${declared.host}\`; `
      + "ShipIt presents it only to the host inside the secret, so it presented nothing.",
    );
  }
  return { credential: { origin: `https://${host}`, username, password } };
}

// A checkout's working tree, or the bare cache's ref that its LFS fetch uses.
async function readLfsDeclaration(dir: string): Promise<LfsHostConfig | undefined> {
  try {
    if (fs.existsSync(path.join(dir, ".git"))) return resolveShipitConfig(dir).lfs;
    const ref = await resolveCacheFetchRef(dir);
    if (!ref) return undefined;
    const shown = await runGit(["show", `${ref}:shipit.yaml`], dir, PROBE_TIMEOUT_MS);
    return shown.code === 0 ? parseShipitConfigText(shown.stdout).lfs : undefined;
  } catch {
    return undefined;
  }
}

export function createLfsHostCredentialResolver(deps: {
  loadSecrets: (repoUrl: string) => Record<string, string>;
  /** The repository ShipIt recorded for this tree; a tree's `origin` is agent-editable. */
  repoUrlForDir: (dir: string) => string | null;
}): LfsHostCredentialResolver {
  return async (dir, provisionedFor) => {
    const declared = await readLfsDeclaration(dir);
    if (!declared) return null;
    const repoUrl = provisionedFor ?? deps.repoUrlForDir(dir);
    if (!repoUrl) {
      return {
        refusal: `shipit.yaml declares \`lfs.host: ${declared.host}\`, but ShipIt has no record of which `
          + "repository this checkout belongs to, so it looked up no secret.",
        host: declared.host,
      };
    }
    const value = deps.loadSecrets(repoUrl)[declared.credential];
    if (value === undefined) {
      return {
        refusal: `shipit.yaml declares \`lfs.host: ${declared.host}\` with the secret \`${declared.credential}\`, `
          + "but no such secret is set for this repository (Project Settings → Secrets).",
        host: declared.host,
      };
    }
    return parseLfsHostSecret(value, declared);
  };
}
