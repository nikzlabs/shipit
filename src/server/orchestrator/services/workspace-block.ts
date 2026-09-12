import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WorkspaceBlockKind } from "../../shared/types.js";
import { inspectCheckoutBlock, READ_ONLY_BLOCK_KINDS } from "../checkout-durability.js";
import { autoCommitAllowed } from "./auto-commit-gate.js";

export interface WorkspaceBlockDeps {
  sessionManager: {
    get(id: string): SessionInfo | undefined;
    setWorkspaceBlock(id: string, kind: WorkspaceBlockKind | null): boolean;
  };
  /** docs/298 — the broken-workspace marker changed, so the sidebar needs the new list. */
  onSessionsChanged?: () => void;
}

/**
 * docs/298 — publish (or withdraw) the session's broken-workspace state. Only a
 * real change broadcasts, so a session stuck for weeks does not re-push the whole
 * session list on every janitor tick.
 *
 * Every writer goes through here: without the broadcast the sidebar would not
 * learn about the marker until something unrelated pushed a list.
 */
export function recordWorkspaceBlock(
  deps: WorkspaceBlockDeps,
  sessionId: string,
  kind: WorkspaceBlockKind | null,
  logTag: string,
): boolean {
  if (!deps.sessionManager.setWorkspaceBlock(sessionId, kind)) return false;
  console.log(
    kind === null
      ? `[${logTag}] ${sessionId}: workspace no longer blocked`
      : `[${logTag}] ${sessionId}: workspace blocked (${kind}) — keeping it in the sidebar`,
  );
  deps.onSessionsChanged?.();
  return true;
}

export interface ActivationWorkspaceCheckDeps extends WorkspaceBlockDeps {
  createGitManager: (dir: string) => GitManager;
}

/**
 * docs/298 — evaluate the checkout when the user opens the session.
 *
 * The disk janitor is the other writer, and it only ever looks at a session idle
 * enough to evict: an attached viewer stops the tier ladder, and the per-repo
 * sidebar cap can hide a resolved session that a `/session/<id>` URL still opens.
 * So the moment the marker is most useful — the user is looking at the broken
 * session — was the one moment nothing set it.
 *
 * Read-only by construction: `inspectCheckoutBlock`, never `ensureCheckoutDurable`,
 * because opening a tab must not commit and push the user's uncommitted work.
 */
export async function refreshWorkspaceBlockOnActivation(
  deps: ActivationWorkspaceCheckDeps,
  sessionId: string,
  workspaceDir: string,
): Promise<void> {
  const session = deps.sessionManager.get(sessionId);
  // Ops/sandbox checkouts are never swept automatically; nor are they judged here.
  if (!session || !autoCommitAllowed(session)) return;

  const block = await inspectCheckoutBlock(deps.createGitManager(workspaceDir));
  if (block) {
    recordWorkspaceBlock(deps, sessionId, block.kind, "activation");
    return;
  }

  // A clean inspection is not evidence about a kind this check cannot see: a
  // `secret` marker needs a commit attempt and `blocked-by-push` needs a push, so
  // withdrawing either here would lose what the janitor found.
  const current = deps.sessionManager.get(sessionId)?.workspaceBlock;
  if (current === undefined || !READ_ONLY_BLOCK_KINDS.has(current)) return;
  recordWorkspaceBlock(deps, sessionId, null, "activation");
}
