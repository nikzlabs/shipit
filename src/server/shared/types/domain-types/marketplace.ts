import type { AgentId } from "../agent-types.js";

export interface SkillInfo {
  name: string;
  /** Use for disk lookup; frontmatter name can differ. Fall back to name for legacy output. */
  dirName?: string;
  description?: string;
  source: "project" | "bundled";
}

export type MarketplaceSource =
  | { kind: "github"; ownerRepo: string; ref?: string }
  | { kind: "git";    url: string;      ref?: string }
  | { kind: "local";  path: string }
  | { kind: "url";    url: string };

export type MarketplaceStatus = "ok" | "fetch-failed" | "loading";

export interface MarketplaceInfo {
  id: string;
  source: MarketplaceSource;
  agentId: AgentId;
  autoUpdate: boolean;
  status: MarketplaceStatus;
  lastFetchedAt?: string;
  fetchError?: string;
}

export interface SkillRef {
  name: string;
  /** Source folder may differ from the invocable frontmatter name. */
  dirName?: string;
  description?: string;
}

export interface PluginInfo {
  marketplaceId: string;
  name: string;
  description?: string;
  author?: string;
  category?: string;
  homepage?: string;
  skills: SkillRef[];
  estimatedContextBytes: number;
  pinnedSha?: string;
  lastUpdated?: string;
}

/** .shipit-installed.json marks managed skills; unmarked directories are off-limits. */
export interface InstallMarker {
  marketplaceId: string;
  pluginName: string;
  version: string;
  installedAt: string;
  /** SHA-256 at install; upgrade refuses if the file has changed. */
  skillMdHash: string;
}

export interface InstallResult {
  installedDirs: string[];
  commitHash: string | null;
  invocationTokens: string[];
}
