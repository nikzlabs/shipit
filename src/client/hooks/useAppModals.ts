import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Local open/close (and lightweight data) state for the App-level dialogs that
 * are NOT backed by a store. Search and the keyboard-shortcuts overlay are pure
 * UI toggles; `githubOrgs` is the owner-picker list for NewRepoDialog, loaded
 * lazily when the create-repo dialog opens (see the onCreateNewRepo handlers).
 *
 * Store-backed modals (Settings, Usage, ProjectSettings, Add/New repo, All
 * sessions, file preview/edit, diff) keep their state in their respective
 * stores — only the non-store locals live here.
 */
export interface AppModalsState {
  searchOpen: boolean;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  shortcutsOpen: boolean;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  githubOrgs: string[];
  setGithubOrgs: Dispatch<SetStateAction<string[]>>;
}

export function useAppModals(): AppModalsState {
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Organizations the user can target in NewRepoDialog's owner picker. Loaded
  // lazily when the create-repo dialog opens (see onCreateNewRepo handlers).
  const [githubOrgs, setGithubOrgs] = useState<string[]>([]);

  return { searchOpen, setSearchOpen, shortcutsOpen, setShortcutsOpen, githubOrgs, setGithubOrgs };
}
