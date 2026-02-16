import type { ConversationBranch } from "../../server/types.js";

export function BranchIndicator({
  branches,
  activeBranchId,
  onSwitchBranch,
  onCreateCheckpoint,
}: {
  branches: ConversationBranch[];
  activeBranchId?: string;
  onSwitchBranch: (branchId: string) => void;
  onCreateCheckpoint: () => void;
}) {
  const active = branches.find((branch) => branch.id === activeBranchId) ?? branches[0];

  return (
    <div className="hidden sm:flex items-center gap-2">
      <span className="text-xs text-gray-500 dark:text-gray-400">Branch</span>
      <select
        value={active?.id ?? ""}
        onChange={(e) => onSwitchBranch(e.target.value)}
        className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 border border-gray-300 dark:border-gray-700"
        aria-label="Active branch"
      >
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </select>
      <button
        onClick={onCreateCheckpoint}
        className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        title="Create checkpoint"
      >
        Checkpoint
      </button>
    </div>
  );
}
