import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WorkspaceBlockKind } from "../../shared/types.js";
import { inspectCheckoutBlock } from "../checkout-durability.js";
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
 * The one kind the open-time check decides completely, and therefore the only one
 * it may raise or withdraw.
 *
 * `secret` needs `autoCommit`'s scan and `blocked-by-push` needs a push attempt, so
 * a clean read-only inspection is no evidence about either. `unreadable` is the
 * subtle one: `git status` sees an omitted *directory*, but an unreadable FILE
 * looks merely modified and is only discovered when `git add` fails — and the
 * stored marker does not say which variant it was. So a marker of any other kind
 * belongs to the janitor, and activation leaves the session entirely alone rather
 * than overwrite it with a kind it can see or withdraw it on evidence it lacks.
 */
const OPEN_TIME_KIND: WorkspaceBlockKind = "conflict";

const inFlight = new Set<string>();

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
  if (!activationOwnsMarker(deps, sessionId)) return;

  // Reconnects can activate the same session repeatedly; one answer serves them all,
  // and two overlapping checks could otherwise settle in the order they finished.
  if (inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  let block;
  try {
    block = await inspectCheckoutBlock(deps.createGitManager(workspaceDir));
  } finally {
    inFlight.delete(sessionId);
  }

  // The inspection awaited, so re-ask: a janitor pass that started before the
  // viewer attached may have recorded something this check must not overwrite.
  if (!activationOwnsMarker(deps, sessionId)) return;
  if (block && block.kind !== OPEN_TIME_KIND) return;
  recordWorkspaceBlock(deps, sessionId, block ? block.kind : null, "activation");
}

function activationOwnsMarker(deps: WorkspaceBlockDeps, sessionId: string): boolean {
  const current = deps.sessionManager.get(sessionId)?.workspaceBlock;
  return current === undefined || current === OPEN_TIME_KIND;
}
