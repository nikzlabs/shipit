/**
 * Writes the granted destinations into the session's credentials subtree
 * (docs/305-ssh-hosts).
 *
 * Only public material lands here: a `Host` block, the recorded host key, and
 * the `.pub` file `IdentityFile` names. `IdentityFile` may name a `.pub` when
 * the private half is in an agent, which is what keeps the private key off every
 * path mounted into the container.
 *
 * The agent can edit all of it. That only weakens its own protection: the signer
 * learns the host key from the server's own `session-bind` signature, never from
 * `known_hosts`, and refuses any other.
 */

import fs from "node:fs";
import path from "node:path";
import { perSessionCredentialsDir } from "./session-credentials-scaffold.js";
import { chownTreeToSessionWorker, sealDirMode } from "./session-worker-uid.js";
import { knownHostsLine } from "./ssh-hosts.js";
import { getErrorMessage } from "../shared/utils.js";
import type { SshHostPublic } from "../shared/types.js";

export const SSH_AGENT_SOCKET_PATH = "/run/shipit/ssh-agent.sock";
const SSH_SUBDIR = ".ssh";

export interface AliasedSshHost {
  /** What the user types after `ssh`. */
  alias: string;
  host: SshHostPublic;
  /** base64 of the recorded server host key, when there is one. */
  hostKeyBlob?: string;
}

/**
 * Aliases are derived from labels and deduplicated in registry order, so the
 * same grant always produces the same config.
 */
export function aliasSshHosts(
  hosts: readonly SshHostPublic[],
  hostKeys: ReadonlyMap<string, string>,
): AliasedSshHost[] {
  const taken = new Set<string>();
  return hosts.map((host) => {
    const base = host.label.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
      || host.id.replace(/[^a-z0-9_.-]+/gi, "-");
    let alias = base;
    let n = 2;
    while (taken.has(alias)) alias = `${base}-${n++}`;
    taken.add(alias);
    const blob = hostKeys.get(host.id);
    return { alias, host, ...(blob ? { hostKeyBlob: blob } : {}) };
  });
}

export function renderSshConfig(entries: readonly AliasedSshHost[]): string {
  const blocks = entries.map(({ alias, host }) => [
    `Host ${alias}`,
    `  HostName ${host.address}`,
    `  User ${host.user}`,
    `  Port ${host.port}`,
    `  IdentityAgent ${SSH_AGENT_SOCKET_PATH}`,
    `  IdentityFile ~/.ssh/${alias}.pub`,
    "  IdentitiesOnly yes",
    // The signer's recorded key is what counts (req 9); this only answers the
    // client's own prompt on the first connection.
    "  StrictHostKeyChecking accept-new",
    "  UserKnownHostsFile ~/.ssh/known_hosts",
    "  ForwardAgent no",
  ].join("\n"));
  return blocks.length > 0
    ? `# Written by ShipIt. Destinations granted to this session.\n\n${blocks.join("\n\n")}\n`
    : "# Written by ShipIt. No SSH destinations are granted to this session.\n";
}

export function renderKnownHosts(entries: readonly AliasedSshHost[]): string {
  const lines = entries
    .filter((e) => e.hostKeyBlob)
    .map((e) => knownHostsLine(e.host.address, e.host.port, e.hostKeyBlob!));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Rewrite the whole `~/.ssh` ShipIt owns. A full rewrite rather than a patch is
 * what makes revocation work: a `.pub` left behind after a grant is removed
 * would keep `ssh <alias>` looking configured.
 */
export function provisionSessionSsh(
  credentialsRoot: string,
  sessionId: string,
  entries: readonly AliasedSshHost[],
): void {
  const dir = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SSH_SUBDIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const wanted = new Map<string, string>([
    ["config", renderSshConfig(entries)],
    ["known_hosts", renderKnownHosts(entries)],
  ]);
  for (const { alias, host } of entries) wanted.set(`${alias}.pub`, `${host.publicLine}\n`);

  // This runs at every turn, not only at a grant edit, so an unchanged grant
  // must cost nothing: a rewrite would re-chown the subtree each time.
  let changed = false;
  for (const [name, contents] of wanted) {
    const file = path.join(dir, name);
    if (readIfPresent(file) === contents) continue;
    fs.writeFileSync(file, contents, { mode: name === "config" ? 0o600 : 0o644 });
    changed = true;
  }
  for (const entry of fs.readdirSync(dir)) {
    if (wanted.has(entry)) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    changed = true;
  }
  if (!changed) return;

  // Hand back only this subtree: the rest of the session's credentials was
  // already handed over at container creation, and `.claude` can be large.
  chownTreeToSessionWorker(dir);
  sealDirMode(dir);
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export interface SshGrantSource {
  credentialsDir: string;
  credentialStore: {
    listSshHosts(): SshHostPublic[];
    getSshHostKeyBlob(id: string): string | undefined;
  };
  sessionManager: { get(id: string): { sshHosts?: string[] } | undefined };
}

/**
 * Write `~/.ssh` from the session's durable grant. Called on a grant edit, when
 * a granted destination changes, and at every turn's environment preparation —
 * a derive-and-rewrite rather than a patch, so a container recreated without any
 * of those events still gets the current config.
 */
export function provisionSessionSshFromGrant(deps: SshGrantSource, sessionId: string): void {
  const granted = new Set(deps.sessionManager.get(sessionId)?.sshHosts ?? []);
  const hosts = deps.credentialStore.listSshHosts().filter((h) => granted.has(h.id));
  const keys = new Map<string, string>();
  for (const host of hosts) {
    const blob = deps.credentialStore.getSshHostKeyBlob(host.id);
    if (blob) keys.set(host.id, blob);
  }
  try {
    provisionSessionSsh(deps.credentialsDir, sessionId, aliasSshHosts(hosts, keys));
  } catch (err) {
    console.error(`[ssh] provisioning ~/.ssh for ${sessionId} failed:`, getErrorMessage(err));
  }
}
