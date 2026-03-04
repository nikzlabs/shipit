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
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="usage-modal-backdrop"
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Usage Summary"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Usage Summary</h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {/* Current session */}
          <section>
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">This session</h3>
            {currentSessionUsage ? (
              <div className="space-y-1 text-sm">
                {modelInfo && (
                  <div className="flex justify-between">
                    <span className="text-gray-500 dark:text-gray-400">Model</span>
                    <span className="text-gray-900 dark:text-gray-100" data-testid="usage-model-name">{formatModelName(modelInfo.model)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Cost</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatCost(currentSessionUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Turns</span>
                  <span className="text-gray-900 dark:text-gray-100">{currentSessionUsage.turnCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Duration</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatDuration(currentSessionUsage.totalDurationMs)}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No usage data yet</p>
            )}
          </section>

          {/* Context usage */}
          {modelInfo && contextTokens !== undefined && contextTokens > 0 && (
            <section data-testid="context-usage-section">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Context usage</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Tokens used</span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {formatTokenCount(contextTokens)} / {formatTokenCount(modelInfo.contextWindowTokens)}
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${levelBarColors[contextLevel]}`}
                    style={{ width: `${contextPercentage}%` }}
                    data-testid="context-usage-bar"
                  />
                </div>
                <div className="text-right text-gray-500">{Math.round(contextPercentage)}%</div>
              </div>
            </section>
          )}

          {/* Per-turn token breakdown */}
          {hasTurnTokens && turnTokens && turnTokens.length > 0 && (
            <section data-testid="turn-breakdown-section">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Per-turn breakdown</h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {[...turnTokens].reverse().map((turn, i) => {
                  const turnNum = turnTokens.length - i;
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between text-xs py-1 border-b border-gray-200 dark:border-gray-800 last:border-0 font-mono"
                    >
                      <span className="text-gray-500 w-8">#{turnNum}</span>
                      <span className="text-gray-700 dark:text-gray-300">
                        In: {turn.inputTokens !== undefined ? formatTokenCount(turn.inputTokens) : "\u2014"}
                      </span>
                      <span className="text-gray-700 dark:text-gray-300">
                        Out: {turn.outputTokens !== undefined ? formatTokenCount(turn.outputTokens) : "\u2014"}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">{formatCost(turn.costUsd)}</span>
                      <span className="text-gray-500">{formatDuration(turn.durationMs)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Token totals */}
          {hasTurnTokens && (
            <section data-testid="token-totals-section">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Token totals</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Input</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatTokenCount(totalInputTokens)} tokens</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Output</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatTokenCount(totalOutputTokens)} tokens</span>
                </div>
              </div>
            </section>
          )}

          {/* All sessions */}
          <section>
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">All sessions</h3>
            {allUsage && allUsage.totalTurns > 0 ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Cost</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatCost(allUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Turns</span>
                  <span className="text-gray-900 dark:text-gray-100">{allUsage.totalTurns}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No usage data yet</p>
            )}
          </section>

          {/* Per-session breakdown */}
          {allUsage && allUsage.sessions.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Recent sessions</h3>
              <div className="space-y-1">
                {allUsage.sessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center justify-between text-sm py-1 border-b border-gray-200 dark:border-gray-800 last:border-0"
                  >
                    <span className="text-gray-700 dark:text-gray-300 truncate mr-3" title={s.sessionId}>
                      {getSessionTitle(s.sessionId)}
                    </span>
                    <span className="text-gray-900 dark:text-gray-100 shrink-0">{formatCost(s.totalCostUsd)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
