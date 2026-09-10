import type { SecretFinding } from "../../shared/secret-scan.js";
import type { SessionSecretBlock, WsServerMessage } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { formatSecretScanNotice } from "./secret-scan-notice.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";

const REMEDIATION_PROMPT = loadPrompt(import.meta.url, "../prompts/secret-block-remediation.md");

// Bound retries because each failed remediation can trigger another refusal.
export const MAX_SECRET_BLOCK_NOTIFY = 2;

export interface SecretBlockCtx {
  sessionId: string;
  sessionManager: {
    getSecretBlock(id: string): SessionSecretBlock | undefined;
    setSecretBlock(id: string, block: SessionSecretBlock | null): void;
  };
  chatHistory: Parameters<typeof emitNoticePostTurn>[1];
  emit: (m: WsServerMessage) => void;
  runner?: Pick<SessionRunnerInterface, "dispatch" | "running"> | null;
  now?: () => Date;
}

// Scan order must not reset the retry budget.
function findingsKey(findings: SecretFinding[]): string {
  return findings
    .map((f) => `${f.rule}:${f.file}:${f.line ?? ""}`)
    .sort()
    .join("|");
}

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

  // Record each refused turn even when the block already exists.
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

export function clearSecretBlock(
  ctx: Pick<SecretBlockCtx, "sessionId" | "sessionManager" | "emit">,
): void {
  if (ctx.sessionManager.getSecretBlock(ctx.sessionId) === undefined) return;
  ctx.sessionManager.setSecretBlock(ctx.sessionId, null);
  ctx.emit({ type: "secret_block_status", sessionId: ctx.sessionId, block: null });
}

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
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
  }));
}
