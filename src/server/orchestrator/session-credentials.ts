/**
 * Per-agent credential isolation (docs/138) — public facade.
 *
 * This file used to hold the whole credential subsystem. As of the P7 split
 * (docs/201) it is a thin facade that re-exports the public API from four
 * focused modules so existing callers (`import { … } from "./session-credentials.js"`)
 * keep working unchanged:
 *
 *   - {@link ./session-credentials-scaffold.js} — per-session dir creation +
 *     shared (non-agent) config copying.
 *   - {@link ./session-agent-credentials.js} — pinned-agent / provider-account
 *     credential provisioning + sub-agent provision/remove.
 *   - {@link ./token-sync-manager.js} — per-turn OAuth token sync in/out +
 *     repush, token-freshness readers, and the docs/153 leaked-symlink repair.
 *   - {@link ./repo-memory-manager.js} — per-repo Claude memory provisioning +
 *     sync-back.
 *
 * No behavior change: which files are copied where, when tokens are
 * fetched/written-back, the rotation handling, and which credentials a sub-agent
 * receives are all preserved exactly.
 */

// ---- Per-session scaffold ----
export {
  SESSION_CREDENTIALS_SUBDIR,
  perSessionCredentialsDir,
  chownSessionCredentialsTree,
  perSessionCredentialsSubpath,
  ensureSessionCredentialsScaffold,
  removeSessionCredentials,
  sessionCredentialsRoot,
} from "./session-credentials-scaffold.js";

// ---- Per-agent / provider-account credential provisioning ----
export {
  provisionAgentCredentials,
  provisionProviderAccountCredentials,
  provisionSubAgentCredentials,
  removeSubAgentCredentials,
} from "./session-agent-credentials.js";

// ---- Per-turn OAuth token sync ----
export type { AgentSessionIdRecoveryCallback } from "./token-sync-manager.js";
export {
  readCodexTokenFreshness,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  repushAgentToken,
  repushProviderAccountToken,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "./token-sync-manager.js";

// ---- Per-repo Claude memory sharing ----
export {
  REPO_MEMORY_SUBDIR,
  repoMemoryDir,
  provisionRepoMemory,
  syncMemoryBack,
} from "./repo-memory-manager.js";
