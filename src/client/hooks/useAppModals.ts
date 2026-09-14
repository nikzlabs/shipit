import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export interface AppModalsState {
  searchOpen: boolean;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  /**
   * Opens the chat search bar AND puts the cursor in it, even when the bar is
   * already open — otherwise re-pressing the search chord from the composer
   * swallows the key and the user types their query into the message draft.
   * The bar focuses on mount, so `searchFocusKey` remounts it as its `key`.
   */
  openSearch: () => void;
  searchFocusKey: number;
  shortcutsOpen: boolean;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  githubOrgs: string[];
  setGithubOrgs: Dispatch<SetStateAction<string[]>>;
}

export function useAppModals(): AppModalsState {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const [githubOrgs, setGithubOrgs] = useState<string[]>([]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchFocusKey((n) => n + 1);
  }, []);

  return { searchOpen, setSearchOpen, openSearch, searchFocusKey, shortcutsOpen, setShortcutsOpen, githubOrgs, setGithubOrgs };
}
