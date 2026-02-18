export interface FileChipItem {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface FileAttachmentChipsProps {
  files: FileChipItem[];
  onRemove: (index: number) => void;
}

export function FileAttachmentChips({ files, onRemove }: FileAttachmentChipsProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex gap-1.5 flex-wrap" data-testid="file-attachment-chips">
      {files.map((f, i) => {
        const fileName = f.path.split("/").pop() ?? f.path;
        const lineRange = f.startLine && f.endLine ? `L${f.startLine}-${f.endLine}` : null;
        const displayPath = f.path.length > 40 ? "..." + f.path.slice(-37) : f.path;

        return (
          <span
            key={`${f.path}-${f.startLine ?? 0}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-700 dark:text-gray-300 max-w-[200px]"
            title={f.path}
          >
            <svg className="w-3 h-3 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span className="truncate" data-testid="file-chip-name">{displayPath}</span>
            {lineRange && (
              <span className="text-gray-500 dark:text-gray-500 shrink-0" data-testid="file-chip-range">{lineRange}</span>
            )}
            <button
              onClick={() => onRemove(i)}
              className="ml-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0"
              aria-label={`Remove ${fileName}`}
              title={`Remove ${fileName}`}
            >
              &times;
            </button>
          </span>
        );
      })}
    </div>
  );
}
