import { useState, useCallback } from "react";
import { RepoSelector } from "./RepoSelector.js";
import { NewRepoDialog } from "./NewRepoDialog.js";
import { MessageInput } from "./MessageInput.js";
import { DocsViewer } from "./DocsViewer.js";
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
              <div className="h-80">
                <DocsViewer
                  files={repoDocFiles}
                  selectedFile={selectedRepoDoc}
                  content={repoDocContent}
                  onSelectFile={onSelectRepoDoc}
                  onRefresh={onRefreshRepoDocs}
                />
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
