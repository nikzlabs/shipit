import { useState, useCallback } from "react";
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
}: HomeScreenProps) {
  const [showNewRepoDialog, setShowNewRepoDialog] = useState(false);

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

  return (
    <div className="flex flex-col items-center flex-1 min-h-0 px-4 overflow-y-auto">
      <div className="shrink-0 basis-[calc(50%-7rem)]" />
      <div className="w-full max-w-xl space-y-4 shrink-0 pb-8">
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

        <p className={`text-xs text-gray-500 text-center ${selectedRepoUrl ? "invisible" : ""}`}>
          Select a repository above or create a new one to get started.
        </p>
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
