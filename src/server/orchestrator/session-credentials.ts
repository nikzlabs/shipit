export {
  SESSION_CREDENTIALS_SUBDIR,
  perSessionCredentialsDir,
  chownSessionCredentialsTree,
  perSessionCredentialsSubpath,
  ensureSessionCredentialsScaffold,
  removeSessionCredentials,
  sessionCredentialsRoot,
  clearSubtreeBorrows,
  subtreeBorrowInFlight,
} from "./session-credentials-scaffold.js";

export {
  ensureLocalWorkspaceTrust,
  ensureSessionAgentUserConfig,
  ensureSessionAccountCredentials,
  provisionAgentCredentials,
  provisionProviderAccountCredentials,
  provisionSubAgentCredentials,
  provisionSubAgentSpawnHome,
  readSessionAccountMarker,
  readSessionResidentRoute,
  releaseSubAgentCredentials,
  releaseSubAgentSpawnHome,
  removeSubAgentCredentials,
  subAgentSpawnHomeContainerDir,
  subAgentSpawnHomeDir,
  sweepSubAgentSpawnHomes,
  writeSessionAccountMarker,
  writeSessionResidentRoute,
} from "./session-agent-credentials.js";
export type { RecordedResidentRoute } from "./session-agent-credentials.js";

export type { AgentSessionIdRecoveryCallback } from "./token-sync-manager.js";
export {
  readCodexTokenFreshness,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  repushAgentToken,
  repushProviderAccountToken,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
  preserveBorrowedTokensBeforeWipe,
} from "./token-sync-manager.js";

export {
  REPO_MEMORY_SUBDIR,
  repoMemoryDir,
  provisionRepoMemory,
  syncMemoryBack,
} from "./repo-memory-manager.js";
