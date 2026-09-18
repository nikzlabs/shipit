import { join } from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WorkspaceBlockKind } from "../../shared/types.js";
import { inspectCheckoutBlock, pathState } from "../checkout-durability.js";
import { getMessage, sleep } from "../disk-utils.js";
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

export interface ReadOnlyWorkspaceCheckDeps extends WorkspaceBlockDeps {
  createGitManager: (dir: string) => GitManager;
}

/**
 * The one kind a read-only inspection decides completely, and therefore the only
 * one its callers may raise or withdraw.
 *
 * `secret` needs `autoCommit`'s scan and `blocked-by-push` needs a push attempt, so
 * a clean read-only inspection is no evidence about either. `unreadable` is the
 * subtle one: `git status` sees an omitted *directory*, but an unreadable FILE
 * looks merely modified and is only discovered when `git add` fails — and the
 * stored marker does not say which variant it was. So a marker of any other kind
 * belongs to the janitor, and an inspection leaves the session entirely alone
 * rather than overwrite it with a kind it can see or withdraw it on evidence it
 * lacks.
 */
const INSPECTABLE_KIND: WorkspaceBlockKind = "conflict";

const inFlight = new Set<string>();

/** `not-inspected` is the only verdict where no git read happened. */
type CheckoutVerdict = "not-inspected" | "inspected" | "blocked" | "cleared";

/**
 * The shared body of every read-only caller: the ownership rule, the inspection,
 * and the write. Activation and the startup sweep differ in *which* checkouts they
 * reach, never in how one is judged — a second predicate here would be a second
 * classifier, which req 2 of docs/298-broken-workspace-visibility rules out.
 */
async function evaluateCheckout(
  deps: ReadOnlyWorkspaceCheckDeps,
  sessionId: string,
  workspaceDir: string,
  logTag: string,
): Promise<CheckoutVerdict> {
  if (!inspectionMayWrite(deps, sessionId)) return "not-inspected";

  // Reconnects (and a sweep landing beside one) can ask about the same session at
  // once; one answer serves them all, and two overlapping checks could otherwise
  // settle in the order they finished.
  if (inFlight.has(sessionId)) return "not-inspected";
  inFlight.add(sessionId);
  let block;
  try {
    block = await inspectCheckoutBlock(deps.createGitManager(workspaceDir));
  } finally {
    inFlight.delete(sessionId);
  }

  // The inspection awaited, so re-ask: a janitor pass that started before this one
  // may have evicted the session or recorded something this must not overwrite.
  if (!inspectionMayWrite(deps, sessionId)) return "inspected";
  if (block && block.kind !== INSPECTABLE_KIND) return "inspected";
  if (block) {
    recordWorkspaceBlock(deps, sessionId, block.kind, logTag);
    return "blocked";
  }
  return recordWorkspaceBlock(deps, sessionId, null, logTag) ? "cleared" : "inspected";
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
  deps: ReadOnlyWorkspaceCheckDeps,
  sessionId: string,
  workspaceDir: string,
): Promise<void> {
  const session = deps.sessionManager.get(sessionId);
  // Ops/sandbox checkouts are never swept automatically; nor are they judged here.
  if (!session || !autoCommitAllowed(session)) return;
  await evaluateCheckout(deps, sessionId, workspaceDir, "activation");
}

function inspectionMayWrite(deps: WorkspaceBlockDeps, sessionId: string): boolean {
  const session = deps.sessionManager.get(sessionId);
  // Eviction is terminal for the marker: every later pass skips an evicted session,
  // so a stale answer landing after one wipes its checkout would stick for good.
  if (!session || session.diskTier === "evicted") return false;
  const current = session.workspaceBlock;
  return current === undefined || current === INSPECTABLE_KIND;
}

export interface WorkspaceSweepDeps extends ReadOnlyWorkspaceCheckDeps {
  sessionManager: WorkspaceBlockDeps["sessionManager"] & { listAll(): SessionInfo[] };
  paceMs?: number;
}

export interface WorkspaceSweepResult {
  /** Checkouts the sweep actually read, including any whose answer it may not write. */
  checked: number;
  /** Of those, the ones found blocked — the state now, not the change. */
  blocked: number;
  /** Of those, the ones whose marker this pass withdrew. */
  cleared: number;
  /** Sessions never read: nothing on disk, or a marker this pass does not own. */
  skipped: number;
  failed: number;
}

const SWEEP_TAG = "startup";

/**
 * docs/298 — re-establish every marker once, after the orchestrator boots.
 *
 * The other two writers are both reached by an event: the janitor only inspects a
 * checkout it is *about to evict* (`escalateDiskTiers` passes over anything not
 * currently eligible to descend), and activation needs the user to open the tab. A
 * session that is `hot` because it was viewed yesterday sits between the two and is
 * evaluated by neither — which is how the incident session stayed unmarked across
 * two janitor passes after a redeploy. A redeploy is when an operator expects the
 * truth to be re-established, so this is the trigger that closes the gap; a
 * periodic health pass was considered for it and deliberately not built.
 *
 * Read-only, like activation: a redeploy must not commit and push anybody's
 * uncommitted work.
 */
export async function sweepWorkspaceBlocksAtStartup(
  deps: WorkspaceSweepDeps,
): Promise<WorkspaceSweepResult> {
  const result: WorkspaceSweepResult = {
    checked: 0, blocked: 0, cleared: 0, skipped: 0, failed: 0,
  };

  for (const session of deps.sessionManager.listAll()) {
    const dir = session.workspaceDir;
    // No checkout on disk, or one no automatic sweep ever judges (ops/sandbox).
    if (session.diskTier === "evicted" || !dir || !autoCommitAllowed(session)) {
      result.skipped += 1;
      continue;
    }
    // `unknown` is "could not ask", which is not evidence of health: leave any
    // existing marker exactly where it is.
    if ((await pathState(join(dir, ".git"))) !== "present") {
      result.skipped += 1;
      continue;
    }

    await sleep(deps.paceMs ?? 0);
    try {
      const verdict = await evaluateCheckout(deps, session.id, dir, SWEEP_TAG);
      if (verdict === "not-inspected") {
        result.skipped += 1;
        continue;
      }
      result.checked += 1;
      if (verdict === "blocked") result.blocked += 1;
      else if (verdict === "cleared") result.cleared += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(
        `[${SWEEP_TAG}] workspace sweep: inspection failed for ${session.id}:`,
        getMessage(err),
      );
    }
  }

  // Unconditional, unlike its hourly neighbours: an operator reading a redeploy
  // needs "the sweep ran and found nothing" to be a statement, not an absence.
  console.log(
    `[${SWEEP_TAG}] workspace sweep: checked=${result.checked} blocked=${result.blocked} `
    + `cleared=${result.cleared} skipped=${result.skipped} failed=${result.failed}`,
  );
  return result;
}
