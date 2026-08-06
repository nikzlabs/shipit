/**
 * docs/213 / SHI-315 — the single owner of "auto-commit is blocked by a likely
 * secret" as a piece of *session state*, rather than as a one-off chat line.
 *
 * ## Why this module exists
 *
 * The original secret-scan guard (docs/213) surfaced a refusal as exactly one
 * thing: a persisted `system_notice` row. That was correct as far as it went —
 * the notice is real transcript content and it survives a reload — but it left
 * the failure effectively invisible in practice, for two compounding reasons:
 *
 *  1. **The notice scrolls.** It renders with the same weight as any other chat
 *     row, so a block announced before three long agent turns is three long
 *     agent turns above the fold. The user who hit this in the field found it by
 *     accident, days later.
 *  2. **Nobody was told who could act.** The notice goes only to the browser.
 *     Nothing feeds a `system_notice` into an agent prompt, and the refusal
 *     fires *post*-turn, so the agent finished believing its edits shipped and
 *     kept building on a branch that could no longer commit.
 *
 * And the consequence is not confined to the offending line. `autoCommit` does
 * `git add -A` and scans the WHOLE staged diff, so while that credential sits in
 * the working tree **every subsequent turn re-stages it, re-trips the scan, and
 * commits nothing at all** — including the unrelated work of every later turn.
 * Auto-push and the PR card short-circuit on the null hash, so the branch simply
 * stops advancing, silently. That is the actual bug: not a missed message, but
 * an unbounded, unannounced stop-the-world on a session's persistence.
 *
 * So a refusal now produces three things, and this module is where all three are
 * decided together:
 *
 *  - the persisted **notice** (unchanged — the transcript record),
 *  - a persisted **block state** driving a sticky banner that cannot scroll away
 *    and cannot be lost to a container reaping, and
 *  - a **bounded remediation turn** so the actor who wrote the credential is the
 *    one asked to remove it.
 *
 * ## Why the notify budget is small, and why the prompt forbids the allow-marker
 *
 * The block re-arises on every turn, so an unconditional "tell the agent" would
 * dispatch a turn per turn until someone noticed — the same unbounded behaviour
 * in a more expensive costume. {@link MAX_SECRET_BLOCK_NOTIFY} caps it.
 *
 * The cheapest way for an agent to make a scanner error disappear is to append
 * `gitleaks:allow` to the line, which silences the guard while looking exactly
 * like a fix. `secret-block-remediation.md` forbids that explicitly and routes
 * suspected false positives back to the user, who is the only party who can
 * legitimately decide a matched credential is fake. Keep that clause if the
 * prompt is ever rewritten.
 */

import type { SecretFinding } from "../../shared/secret-scan.js";
import type { SessionSecretBlock, WsServerMessage } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { formatSecretScanNotice } from "./secret-scan-notice.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";

/** Loaded once at module init — see CLAUDE.md › Prompts. */
const REMEDIATION_PROMPT = loadPrompt(import.meta.url, "../prompts/secret-block-remediation.md");

/**
 * How many remediation turns one block may spend. Two: enough for the agent to
 * scrub an accidental paste and, if its first attempt missed, try once more.
 * Past that the situation needs a human, and the banner is what asks for one.
 */
export const MAX_SECRET_BLOCK_NOTIFY = 2;

/** The minimum a caller must provide to record/clear a block. */
export interface SecretBlockCtx {
  sessionId: string;
  sessionManager: {
    getSecretBlock(id: string): SessionSecretBlock | undefined;
    setSecretBlock(id: string, block: SessionSecretBlock | null): void;
  };
  chatHistory: Parameters<typeof emitNoticePostTurn>[1];
  /** Broadcast to attached viewers (`runner.emitMessage` or the per-connection emit). */
  emit: (m: WsServerMessage) => void;
  /** Absent for paths with no runner — the notice + banner still fire. */
  runner?: Pick<SessionRunnerInterface, "dispatch" | "running"> | null;
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date;
}

/**
 * Stable identity of a finding set, so a *different* leak after a partial fix
 * counts as a new block (fresh notify budget) rather than inheriting the
 * exhausted budget of the one before it. Sorted so ordering noise in the diff
 * scan can't manufacture a false "new block".
 */
function findingsKey(findings: SecretFinding[]): string {
  return findings
    .map((f) => `${f.rule}:${f.file}:${f.line ?? ""}`)
    .sort()
    .join("|");
}

/**
 * Record a refused auto-commit: persist the block, surface the notice, push the
 * sticky banner, and (within budget) ask the agent to scrub the credential.
 *
 * Idempotent across the repeated refusals of a standing block: re-blocking with
 * the same findings keeps the original `at` and the spent notify budget, so the
 * banner does not "reset" and the agent is not re-nagged every turn.
 *
 * Returns the block that is now in force.
 */
export function recordSecretBlock(
  ctx: SecretBlockCtx,
  findings: SecretFinding[],
): SessionSecretBlock {
  if (findings.length === 0) {
    throw new Error("recordSecretBlock: findings must be non-empty");
  }
  const now = ctx.now ?? (() => new Date());
  const previous = ctx.sessionManager.getSecretBlock(ctx.sessionId);
  const isSameBlock =
    previous !== undefined && findingsKey(previous.findings) === findingsKey(findings);

  const block: SessionSecretBlock = {
    findings,
    at: isSameBlock ? previous.at : now().toISOString(),
    notifyCount: isSameBlock ? previous.notifyCount : 0,
  };

  // The notice is transcript content and is emitted on EVERY refusal, not just
  // the first: each one marks a distinct turn whose work did not land, and the
  // transcript is the record of what happened when. The banner is what stops it
  // from having to be noticed.
  emitNoticePostTurn(
    ctx.emit,
    ctx.chatHistory,
    ctx.sessionId,
    formatSecretScanNotice(findings),
    "warn",
  );

  if (block.notifyCount < MAX_SECRET_BLOCK_NOTIFY && ctx.runner) {
    block.notifyCount += 1;
    dispatchRemediationTurn(ctx.runner, findings);
  }

  ctx.sessionManager.setSecretBlock(ctx.sessionId, block);
  ctx.emit({ type: "secret_block_status", sessionId: ctx.sessionId, block });
  return block;
}

/**
 * Clear the block after a commit lands. A no-op (no write, no broadcast) when
 * nothing was blocked, so the overwhelmingly common clean-commit path costs one
 * cached session read and nothing else.
 */
export function clearSecretBlock(
  ctx: Pick<SecretBlockCtx, "sessionId" | "sessionManager" | "emit">,
): void {
  if (ctx.sessionManager.getSecretBlock(ctx.sessionId) === undefined) return;
  ctx.sessionManager.setSecretBlock(ctx.sessionId, null);
  ctx.emit({ type: "secret_block_status", sessionId: ctx.sessionId, block: null });
}

/**
 * Ask the agent to remove the credential. `dispatch` enqueues when a turn is
 * already running, so this is safe to call from the post-turn flow regardless of
 * whether a queued user turn has already drained ahead of us.
 */
function dispatchRemediationTurn(
  runner: Pick<SessionRunnerInterface, "dispatch" | "running">,
  findings: SecretFinding[],
): void {
  const list = findings
    .map((f) => `- \`${f.line ? `${f.file}:${f.line}` : f.file}\` — ${f.description} (\`${f.redacted}\`)`)
    .join("\n");
  runner.dispatch(prepareDispatch({
    text: fillPromptTokens(REMEDIATION_PROMPT, { FINDINGS: list }),
    agentInterface: undefined,
    activity: "Removing a credential…",
    execution: undefined,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
    systemTurn: true,
    onTurnComplete: undefined,
    deliveryId: undefined,
    dictated: undefined,
  }));
}
