

import { useState } from "react";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";

function normalizeRepoUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

export interface RepoTrust {

  untrusted: boolean;

  trusting: boolean;

  trust: () => Promise<void>;
}

export function useRepoTrust(repoUrl: string | undefined): RepoTrust {
  const repos = useRepoStore((s) => s.repos);
  const [trusting, setTrusting] = useState(false);

  const key = repoUrl ? normalizeRepoUrl(repoUrl) : undefined;
  const repo = key ? repos.find((r) => normalizeRepoUrl(r.url) === key) : undefined;

  const trust = async () => {

    if (!repo || trusting) return;
    setTrusting(true);
    try {
      const trusted = await useRepoStore.getState().trustRepo(repo.url);
      if (!trusted) {
        useUiStore.getState().setToast({ message: "Repository trust could not be saved. Try again." });
      }
    } finally {
      setTrusting(false);
    }
  };

  return { untrusted: repo?.trusted === false, trusting, trust };
}
