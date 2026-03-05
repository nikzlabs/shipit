import { Button } from "./ui/button.js";
import { Modal } from "./ui/modal.js";
import type { SessionInfo } from "../../server/shared/types.js";
import { formatModelName, formatTokenCount, getContextLevel, type ModelInfo } from "./StatusBar.js";

export interface SessionUsage {
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totalCostUsd: number;
  totalTurns: number;
}

export interface TurnTokenData {
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  durationMs: number;
}

interface UsageModalProps {
  currentSessionUsage: SessionUsage | null;
  allUsage: UsageStats | null;
  sessions: SessionInfo[];
  onClose: () => void;
  modelInfo?: ModelInfo | null;
  contextTokens?: number;
  turnTokens?: TurnTokenData[];
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms === 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

const levelBarColors: Record<string, string> = {
  green: "bg-(--color-success)",
  yellow: "bg-(--color-warning)",
  orange: "bg-(--color-context-high)",
  red: "bg-(--color-error)",
};

export function UsageModal({ currentSessionUsage, allUsage, sessions, onClose, modelInfo, contextTokens, turnTokens }: UsageModalProps) {
  // Look up session titles by ID
  const getSessionTitle = (sessionId: string): string => {
    const session = sessions.find((s) => s.id === sessionId);
    return session?.title ?? sessionId.slice(0, 12) + "...";
  };

  const contextPercentage = modelInfo && modelInfo.contextWindowTokens > 0 && contextTokens
    ? Math.min(100, (contextTokens / modelInfo.contextWindowTokens) * 100)
    : 0;
  const contextLevel = getContextLevel(contextPercentage);

  // Compute cumulative token totals from turn data
  const totalInputTokens = turnTokens?.reduce((sum, t) => sum + (t.inputTokens ?? 0), 0) ?? 0;
  const totalOutputTokens = turnTokens?.reduce((sum, t) => sum + (t.outputTokens ?? 0), 0) ?? 0;
  const hasTurnTokens = turnTokens && turnTokens.some((t) => t.inputTokens !== undefined || t.outputTokens !== undefined);

  return (
    <Modal
      onClose={onClose}
      className="rounded-lg border-(--color-border-secondary) max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
      data-testid="usage-modal-backdrop"
      role="dialog"
      aria-label="Usage Summary"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <h2 className="text-lg font-semibold text-(--color-text-primary)">Usage Summary</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </Button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {/* Current session */}
          <section>
            <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">This session</h3>
            {currentSessionUsage ? (
              <div className="space-y-1 text-sm">
                {modelInfo && (
                  <div className="flex justify-between">
                    <span className="text-(--color-text-secondary)">Model</span>
                    <span className="text-(--color-text-primary)" data-testid="usage-model-name">{formatModelName(modelInfo.model)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Cost</span>
                  <span className="text-(--color-text-primary)">{formatCost(currentSessionUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Turns</span>
                  <span className="text-(--color-text-primary)">{currentSessionUsage.turnCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Duration</span>
                  <span className="text-(--color-text-primary)">{formatDuration(currentSessionUsage.totalDurationMs)}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* Context usage */}
          {modelInfo && contextTokens !== undefined && contextTokens > 0 && (
            <section data-testid="context-usage-section">
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Context usage</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Tokens used</span>
                  <span className="text-(--color-text-primary)">
                    {formatTokenCount(contextTokens)} / {formatTokenCount(modelInfo.contextWindowTokens)}
                  </span>
                </div>
                <div className="w-full h-2 bg-(--color-bg-tertiary) rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${levelBarColors[contextLevel]}`}
                    style={{ width: `${contextPercentage}%` }}
                    data-testid="context-usage-bar"
                  />
                </div>
                <div className="text-right text-(--color-text-secondary)">{Math.round(contextPercentage)}%</div>
              </div>
            </section>
          )}

          {/* Per-turn token breakdown */}
          {hasTurnTokens && turnTokens && turnTokens.length > 0 && (
            <section data-testid="turn-breakdown-section">
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Per-turn breakdown</h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {[...turnTokens].reverse().map((turn, i) => {
                  const turnNum = turnTokens.length - i;
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between text-xs py-1 border-b border-(--color-border-primary) last:border-0 font-mono"
                    >
                      <span className="text-(--color-text-secondary) w-8">#{turnNum}</span>
                      <span className="text-(--color-text-primary)">
                        In: {turn.inputTokens !== undefined ? formatTokenCount(turn.inputTokens) : "\u2014"}
                      </span>
                      <span className="text-(--color-text-primary)">
                        Out: {turn.outputTokens !== undefined ? formatTokenCount(turn.outputTokens) : "\u2014"}
                      </span>
                      <span className="text-(--color-text-secondary)">{formatCost(turn.costUsd)}</span>
                      <span className="text-(--color-text-secondary)">{formatDuration(turn.durationMs)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Token totals */}
          {hasTurnTokens && (
            <section data-testid="token-totals-section">
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Token totals</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Input</span>
                  <span className="text-(--color-text-primary)">{formatTokenCount(totalInputTokens)} tokens</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Output</span>
                  <span className="text-(--color-text-primary)">{formatTokenCount(totalOutputTokens)} tokens</span>
                </div>
              </div>
            </section>
          )}

          {/* All sessions */}
          <section>
            <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">All sessions</h3>
            {allUsage && allUsage.totalTurns > 0 ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Cost</span>
                  <span className="text-(--color-text-primary)">{formatCost(allUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Turns</span>
                  <span className="text-(--color-text-primary)">{allUsage.totalTurns}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* Per-session breakdown */}
          {allUsage && allUsage.sessions.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Recent sessions</h3>
              <div className="space-y-1">
                {allUsage.sessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center justify-between text-sm py-1 border-b border-(--color-border-primary) last:border-0"
                  >
                    <span className="text-(--color-text-primary) truncate mr-3" title={s.sessionId}>
                      {getSessionTitle(s.sessionId)}
                    </span>
                    <span className="text-(--color-text-primary) shrink-0">{formatCost(s.totalCostUsd)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
    </Modal>
  );
}
