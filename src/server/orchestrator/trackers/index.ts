/**
 * Tracker abstraction barrel (docs/170 — inline tracker Issues tab).
 */

export {
  TrackerResolutionError,
  type Tracker,
  type ListIssuesOptions,
  type SetAssigneeOptions,
} from "./tracker.js";
export {
  TrackerRegistry,
  buildTrackerRegistry,
  type GitHubTrackerContext,
} from "./registry.js";
export {
  LinearTracker,
  listLinearTeams,
  resolveLinearStateId,
  LINEAR_GRAPHQL_ENDPOINT,
  type FetchImpl,
} from "./linear/adapter.js";
export {
  GitHubTracker,
  mapGitHubPriority,
  resolveGitHubState,
  type GitHubRepoRef,
} from "./github/adapter.js";
