import { useState, useCallback, useMemo, useEffect } from "react";
import { marked } from "marked";
import { RepoSelector } from "./RepoSelector.js";
import { NewRepoDialog } from "./NewRepoDialog.js";
import { MessageInput } from "./MessageInput.js";
import type { TemplateInfo } from "./TemplateSelector.js";
import type { SessionInfo, PermissionMode, FileContextRef, FileTreeNode } from "../../server/types.js";

interface RepoResult {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface HomeScreenProps {
  sessions: SessionInfo[];
  githubStatus: { authenticated: boolean; username?: string };
  templates: TemplateInfo[];
  onRequestTemplates: () => void;
  onSendWithRepo: (repoUrl: string, text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => void;
  onNewRepo: (repoName: string, description: string, isPrivate: boolean, templateId: string) => void;
  onSearchRepos: (query: string) => void;
  searchResults: RepoResult[];
  disabled: boolean;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  pendingFiles: FileContextRef[];
  onRemoveFile: (index: number) => void;
  onAddFile: (filePath: string) => void;
  fileTree: FileTreeNode[];
  creatingRepo: boolean;
  selectedRepoUrl: string | null;
  onSelectRepo: (repoUrl: string) => void;
  repoDocFiles: string[];
  repoDocContent: string | null;
  selectedRepoDoc: string | null;
  onSelectRepoDoc: (path: string) => void;
  onRefreshRepoDocs: () => void;
}

export function HomeScreen({
  sessions,
  githubStatus,
  templates,
  onRequestTemplates,
  onSendWithRepo,
  onNewRepo,
  onSearchRepos,
  searchResults,
  disabled,
  permissionMode,
  onPermissionModeChange,
  pendingFiles,
  onRemoveFile,
  onAddFile,
  fileTree,
  creatingRepo,
  selectedRepoUrl,
  onSelectRepo,
  repoDocFiles,
  repoDocContent,
  selectedRepoDoc,
  onSelectRepoDoc,
  onRefreshRepoDocs,
}: HomeScreenProps) {
  const [showNewRepoDialog, setShowNewRepoDialog] = useState(false);
  const [docsExpanded, setDocsExpanded] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const handleSend = useCallback(
    (text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => {
      if (!selectedRepoUrl) return;
      onSendWithRepo(selectedRepoUrl, text, images);
    },
    [selectedRepoUrl, onSendWithRepo],
  );

  const handleNewRepoSubmit = useCallback(
    (name: string, description: string, isPrivate: boolean, templateId: string) => {
      onNewRepo(name, description, isPrivate, templateId);
      setShowNewRepoDialog(false);
    },
    [onNewRepo],
  );

  // Auto-select the first doc when the list loads
  useEffect(() => {
    if (repoDocFiles.length > 0 && !selectedRepoDoc) {
      onSelectRepoDoc(repoDocFiles[0]);
    }
  }, [repoDocFiles, selectedRepoDoc, onSelectRepoDoc]);

  const renderedHtml = useMemo(() => {
    if (!repoDocContent) return "";
    return marked.parse(repoDocContent, { async: false }) as string;
  }, [repoDocContent]);

  const hasRepoDocs = repoDocFiles.length > 0;

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-xl space-y-4">
        {/* Repo selector */}
        <RepoSelector
          sessions={sessions}
          searchResults={searchResults}
          onSearch={onSearchRepos}
          selectedRepoUrl={selectedRepoUrl}
          onSelect={onSelectRepo}
          onNewRepo={() => {
            if (templates.length === 0) onRequestTemplates();
            setShowNewRepoDialog(true);
          }}
          disabled={disabled}
        />

        {/* Chat input */}
        <MessageInput
          onSend={handleSend}
          disabled={disabled || !selectedRepoUrl}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          pendingFiles={pendingFiles}
          onRemoveFile={onRemoveFile}
          onAddFile={onAddFile}
          fileTree={fileTree}
        />

        {!selectedRepoUrl && (
          <p className="text-xs text-gray-500 text-center">
            Select a repository above or create a new one to get started.
          </p>
        )}

        {/* Repo docs section — visible when a repo is selected and has docs */}
        {selectedRepoUrl && hasRepoDocs && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <button
              onClick={() => setDocsExpanded(!docsExpanded)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors"
            >
              <span>Docs ({repoDocFiles.length} files)</span>
              <span className="text-xs">{docsExpanded ? "\u25B2" : "\u25BC"}</span>
            </button>

            {docsExpanded && (
              <div className="bg-white dark:bg-gray-900">
                {/* File selector */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                  <div className="relative flex-1 min-w-0">
                    <button
                      onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors max-w-full"
                    >
                      <span className="truncate">{selectedRepoDoc || "Select a file..."}</span>
                      <span className="shrink-0">{isDropdownOpen ? "\u25B2" : "\u25BC"}</span>
                    </button>
                    {isDropdownOpen && (
                      <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded shadow-lg z-10">
                        {repoDocFiles.map((file) => (
                          <button
                            key={file}
                            onClick={() => {
                              onSelectRepoDoc(file);
                              setIsDropdownOpen(false);
                            }}
                            className={`block w-full text-left px-3 py-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors truncate ${
                              file === selectedRepoDoc ? "bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200" : "text-gray-500 dark:text-gray-400"
                            }`}
                          >
                            {file}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={onRefreshRepoDocs}
                    className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0 ml-2"
                    title="Refresh file list"
                  >
                    Reload
                  </button>
                </div>

                {/* Markdown content */}
                <div className="max-h-80 overflow-y-auto p-4">
                  {repoDocContent === null ? (
                    <div className="flex items-center justify-center py-8 text-gray-500 text-sm">
                      Loading...
                    </div>
                  ) : (
                    <div
                      className="prose dark:prose-invert prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* New repo dialog */}
      {showNewRepoDialog && githubStatus.username && (
        <NewRepoDialog
          username={githubStatus.username}
          templates={templates}
          onSubmit={handleNewRepoSubmit}
          onClose={() => setShowNewRepoDialog(false)}
          creating={creatingRepo}
        />
      )}
    </div>
  );
}
