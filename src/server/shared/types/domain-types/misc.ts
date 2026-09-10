// Local runs real behavior without Docker; it is not isTestMode.
export type RuntimeMode = "containerized" | "local";

export interface DocEntry {
  path: string;
  issue?: string;
  title: string;
  description?: string;
  /** Display only: checkout rewrites mtimes, so this cannot identify session changes. */
  modifiedAt?: string;
  changedInSession?: boolean;
  /** From the sibling checklist for plans, otherwise the checklist's own items. */
  checklist?: { total: number; done: number };
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "fullstack" | "backend" | "utility";
  icon: string;
  files: Record<string, string>;
}

export interface SecretRequirement {
  name: string;
  description?: string;
  required?: boolean;
  agent?: boolean;
  /** Unknown platform sources fall through to user-saved secrets. */
  source?: string;
}

export interface DockerMemoryStats {
  usedBytes: number;
  /** Zero means unlimited. */
  totalBytes: number;
  /** Client denominator: user budget clamped to host, or host total when unset. */
  budgetBytes?: number;
  warnAtBytes?: number;
  evictAtBytes?: number;
  bySession?: Record<string, SessionMemoryUsage>;
}

export interface SessionMemoryUsage {
  agentBytes: number;
  serviceBytes: number;
}

export type ReleaseChannel = "stable" | "edge";

export interface VersionInfo {
  channel: ReleaseChannel;
  version: string;
  commit?: string;
  /** Checkout HEAD differs from the running image's commit, indicating an incomplete update. */
  mismatch?: boolean;
}

export interface SystemInfo {
  /** Epoch milliseconds. */
  processStartedAt: number;
  buildId?: string;
  version?: VersionInfo;
  updateMode?: "managed" | "manual";
}

export interface HostContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  /** Unix seconds. */
  createdAt: number;
  sessionId?: string;
  sessionTitle?: string;
  agentRunning?: boolean;
}

export interface HostOverview {
  generatedAt: string;
  dockerAvailable: boolean;
  totals: { containers: number; running: number };
  containers: HostContainerInfo[];
}
