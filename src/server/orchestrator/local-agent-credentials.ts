// Fallback-home links share the account's physical credential file so token rotation cannot diverge.
// Session-scoped spawns use their account root directly (local-agent-home.ts).
import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import { agentHome } from "../shared/agent-home.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";
import { AGENT_CREDENTIAL_PATHS } from "./session-credentials-scaffold.js";

export function isLocalRuntime(): boolean {
  return process.env.RUNTIME_MODE?.toLowerCase() === "local";
}

export type CredentialLinkOutcome =
  | "already-linked"
  | "linked"
  | "no-source"
  | "unlinked"
  | "absent";

export function linkAgentHomeToCredentials(args: {
  credentialsDir: string;
  agentId: AgentId;
  accountId?: string;
  home?: string;
}): Record<string, CredentialLinkOutcome> {
  const home = args.home ?? agentHome();
  const sourceRoot = args.accountId
    ? providerAccountCredentialRoot(args.credentialsDir, args.agentId, args.accountId)
    : args.credentialsDir;

  const outcomes: Record<string, CredentialLinkOutcome> = {};
  for (const rel of AGENT_CREDENTIAL_PATHS[args.agentId]) {
    outcomes[rel] = linkCredentialPath(path.join(sourceRoot, rel), path.join(home, rel));
  }
  return outcomes;
}

export function clearAgentHomeCredentialLinks(args: {
  agentId: AgentId;
  home?: string;
}): Record<string, CredentialLinkOutcome> {
  const home = args.home ?? agentHome();
  const outcomes: Record<string, CredentialLinkOutcome> = {};
  for (const rel of AGENT_CREDENTIAL_PATHS[args.agentId]) {
    const dest = path.join(home, rel);
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) {
      outcomes[rel] = "absent";
      continue;
    }
    fs.rmSync(dest, { force: true });
    outcomes[rel] = "unlinked";
  }
  return outcomes;
}

function linkCredentialPath(src: string, dest: string): CredentialLinkOutcome {
  if (!fs.existsSync(src)) return "no-source";

  const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    let current: string | null = null;
    try {
      current = fs.readlinkSync(dest);
    } catch {
      // Replace an unreadable link.
    }
    if (current === src) return "already-linked";
    fs.rmSync(dest, { force: true });
  } else if (stat) {
    // Preserve older login and conversation files when replacing a real path.
    const aside = `${dest}.shipit-backup-${Date.now()}`;
    fs.renameSync(dest, aside);
    console.warn(
      `[local-credentials] moved pre-existing ${dest} to ${aside} so it can be linked to ${src}. `
        + `If an older login lived there, its conversation state is still in the backup.`,
    );
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(src, dest);
  return "linked";
}
