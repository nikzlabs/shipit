/**
 * Tracker abstraction barrel (docs/170 — inline tracker Issues tab).
 */

export type { Tracker } from "./tracker.js";
export {
  TrackerRegistry,
  buildTrackerRegistry,
  type GitHubTrackerContext,
} from "./registry.js";
export {
  LinearTracker,
  listLinearTeams,
  LINEAR_GRAPHQL_ENDPOINT,
  type FetchImpl,
} from "./linear/adapter.js";
export {
  GitHubTracker,
  mapGitHubPriority,
  type GitHubRepoRef,
} from "./github/adapter.js";
