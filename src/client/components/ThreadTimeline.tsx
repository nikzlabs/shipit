import { useState } from "react";
import type { ThreadInfo, CheckpointInfo } from "../../server/types.js";

export { type ThreadInfo, type CheckpointInfo };

/** Color palette for threads — cycles for > 6 threads. */
const THREAD_COLORS = [
  { dot: "bg-blue-500", line: "bg-blue-500/30", text: "text-blue-400" },
  { dot: "bg-emerald-500", line: "bg-emerald-500/30", text: "text-emerald-400" },
  { dot: "bg-purple-500", line: "bg-purple-500/30", text: "text-purple-400" },
  { dot: "bg-amber-500", line: "bg-amber-500/30", text: "text-amber-400" },
  { dot: "bg-rose-500", line: "bg-rose-500/30", text: "text-rose-400" },
  { dot: "bg-cyan-500", line: "bg-cyan-500/30", text: "text-cyan-400" },
];

function getThreadColor(index: number) {
  return THREAD_COLORS[index % THREAD_COLORS.length];
}

interface TimelineNode {
  type: "checkpoint" | "fork";
  checkpoint: CheckpointInfo;
  threadIndex: number;
  threadName: string;
  threadId: string;
  /** For fork nodes, the child thread that was created from this checkpoint. */
  childThread?: { id: string; name: string; threadIndex: number };
}

export function ThreadTimeline({
  threads,
  activeThreadId,
  onForkThread,
  onSwitchThread,
}: {
  threads: ThreadInfo[];
  activeThreadId: string;
  onForkThread: (checkpointId: string) => void;
  onSwitchThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Build a map of checkpointId → child thread for fork visualization
  const forkMap = new Map<string, { id: string; name: string; threadIndex: number }>();
  threads.forEach((t, i) => {
    if (t.parentCheckpointId) {
      forkMap.set(t.parentCheckpointId, { id: t.id, name: t.name, threadIndex: i });
    }
  });

  // Build timeline nodes from all checkpoints, sorted by creation time
  const nodes: TimelineNode[] = [];
  threads.forEach((thread, threadIndex) => {
    for (const cp of thread.checkpoints) {
      const childThread = forkMap.get(cp.id);
      nodes.push({
        type: childThread ? "fork" : "checkpoint",
        checkpoint: cp,
        threadIndex,
        threadName: thread.name,
        threadId: thread.id,
        childThread,
      });
    }
  });

  nodes.sort((a, b) => new Date(a.checkpoint.createdAt).getTime() - new Date(b.checkpoint.createdAt).getTime());

  // Don't render if there are no checkpoints across any thread
  const totalCheckpoints = nodes.length;
  if (totalCheckpoints === 0 && threads.length <= 1) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-800">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clipRule="evenodd"
            />
          </svg>
          Thread Timeline
          {totalCheckpoints > 0 && (
            <span className="text-gray-400 dark:text-gray-500">
              ({totalCheckpoints} checkpoint{totalCheckpoints !== 1 ? "s" : ""}, {threads.length} thread{threads.length !== 1 ? "s" : ""})
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="max-h-60 overflow-y-auto px-4 pb-3">
          {/* Thread legend */}
          <div className="flex flex-wrap gap-2 mb-2">
            {threads.map((thread, i) => {
              const color = getThreadColor(i);
              const isActive = thread.id === activeThreadId;
              return (
                <button
                  key={thread.id}
                  onClick={() => {
                    if (!isActive) onSwitchThread(thread.id);
                  }}
                  className={`flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                    isActive
                      ? `bg-gray-200 dark:bg-gray-700 ${color.text} font-semibold`
                      : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${color.dot}`} />
                  {thread.name}
                </button>
              );
            })}
          </div>

          {/* Timeline nodes */}
          {nodes.length === 0 ? (
            <p className="text-xs text-gray-500 py-1">No checkpoints yet. Create one to start branching.</p>
          ) : (
            <div className="relative ml-2">
              {/* Vertical line */}
              <div className="absolute left-[5px] top-1 bottom-1 w-px bg-gray-300 dark:bg-gray-700" />

              <div className="space-y-1">
                {nodes.map((node) => {
                  const color = getThreadColor(node.threadIndex);
                  return (
                    <div key={node.checkpoint.id} className="relative flex items-start gap-3 pl-4 py-1 group">
                      {/* Node dot */}
                      <div className={`absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full border-2 border-white dark:border-gray-950 ${color.dot} z-10`} />

                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-700 dark:text-gray-300 truncate">
                            {node.checkpoint.label || `Checkpoint at msg ${node.checkpoint.messageIndex}`}
                          </span>
                          {node.childThread && (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${getThreadColor(node.childThread.threadIndex).dot} mr-1`} />
                              {node.childThread.name}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                          <span className={color.text}>{node.threadName}</span>
                          <span>&middot;</span>
                          <span>{formatRelativeDate(node.checkpoint.createdAt)}</span>
                          <span>&middot;</span>
                          <span className="font-mono">{node.checkpoint.commitHash.slice(0, 7)}</span>
                          <button
                            onClick={() => onForkThread(node.checkpoint.id)}
                            className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-300 transition-all"
                          >
                            fork
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
