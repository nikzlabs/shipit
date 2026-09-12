import { useState, type Dispatch, type SetStateAction } from "react";

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

  const [githubOrgs, setGithubOrgs] = useState<string[]>([]);

  return { searchOpen, setSearchOpen, shortcutsOpen, setShortcutsOpen, githubOrgs, setGithubOrgs };
}
