/** Disabled runs open; no-sidecar refuses contained session startup. */
export type EgressEnforcementStatus = "active" | "disabled" | "no-sidecar";

export interface EgressSettings {
  globalEnabled: boolean;
  globalHosts: string[];
  /** Actual enforcement, separate from the requested global policy. */
  enforcementActive: boolean;
  enforcementStatus: EgressEnforcementStatus;
}

export interface EgressSessionSettings {
  sessionId: string;
  /** Null inherits the global policy. */
  override: boolean | null;
  hosts: string[];
  effectiveContained: boolean;
  globalEnabled: boolean;
  enforcementActive: boolean;
  enforcementStatus: EgressEnforcementStatus;
  /** Startup policy of the live container; null when none exists. Mode changes require restart. */
  startedContained: boolean | null;
  pendingRestart: boolean;
}

export type EgressAllowlistSource = "builtin" | "operator" | "mcp" | "user-global" | "user-session";

export interface EgressAllowlistEntry {
  host: string;
  source: EgressAllowlistSource;
  removable: boolean;
}

/** Only grantable permits a grant button; blocked grants save entries without making hosts reachable. */
export type EgressHostReach = "allowed" | "grantable" | "blocked-by-session" | "blocked-by-deployment";

export type EgressGrantSurface = "new-containers" | "agent" | "services";

/** Server-reported effects; global adds do not reload live containers, while session adds do. */
export interface EgressHostGrantOutcome {
  host: string;
  scope: "session" | "global";
  /** Disjoint from staleUntilRestart; absent surfaces have no stated outcome. */
  liveNow: EgressGrantSurface[];
  staleUntilRestart: EgressGrantSurface[];
  /** Null forbids offering restart: nothing to fix or no single session in scope. */
  restartSessionId: string | null;
  /** Blocked verdicts clear both lists and offer no restart; restarting cannot help. */
  reach: EgressHostReach;
}

export type EgressHostAddResponse = (EgressSettings | EgressSessionSettings) & {
  grant: EgressHostGrantOutcome;
};

export interface EgressAllowlistView {
  entries: EgressAllowlistEntry[];
  globalEnabled: boolean;
  enforcementActive: boolean;
  enforcementStatus: EgressEnforcementStatus;
  session: EgressSessionSettings | null;
  defaultsCustomized: boolean;
}
