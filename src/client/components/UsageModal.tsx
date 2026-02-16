import type { SessionInfo } from "../../server/types.js";

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

interface UsageModalProps {
  currentSessionUsage: SessionUsage | null;
  allUsage: UsageStats | null;
  sessions: SessionInfo[];
  onClose: () => void;
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

export function UsageModal({ currentSessionUsage, allUsage, sessions, onClose }: UsageModalProps) {
  // Look up session titles by ID
  const getSessionTitle = (sessionId: string): string => {
    const session = sessions.find((s) => s.id === sessionId);
    return session?.title ?? sessionId.slice(0, 12) + "...";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="usage-modal-backdrop"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Usage Summary"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-gray-100">Usage Summary</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {/* Current session */}
          <section>
            <h3 className="text-sm font-medium text-gray-400 mb-2">This session</h3>
            {currentSessionUsage ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Cost</span>
                  <span className="text-gray-100">{formatCost(currentSessionUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Turns</span>
                  <span className="text-gray-100">{currentSessionUsage.turnCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Duration</span>
                  <span className="text-gray-100">{formatDuration(currentSessionUsage.totalDurationMs)}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No usage data yet</p>
            )}
          </section>

          {/* All sessions */}
          <section>
            <h3 className="text-sm font-medium text-gray-400 mb-2">All sessions</h3>
            {allUsage && allUsage.totalTurns > 0 ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Cost</span>
                  <span className="text-gray-100">{formatCost(allUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Turns</span>
                  <span className="text-gray-100">{allUsage.totalTurns}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No usage data yet</p>
            )}
          </section>

          {/* Per-session breakdown */}
          {allUsage && allUsage.sessions.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-gray-400 mb-2">Recent sessions</h3>
              <div className="space-y-1">
                {allUsage.sessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center justify-between text-sm py-1 border-b border-gray-800 last:border-0"
                  >
                    <span className="text-gray-300 truncate mr-3" title={s.sessionId}>
                      {getSessionTitle(s.sessionId)}
                    </span>
                    <span className="text-gray-100 shrink-0">{formatCost(s.totalCostUsd)}</span>
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
