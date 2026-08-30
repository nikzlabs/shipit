// ---- Egress settings (docs/172 / planning#92) ----

/**
 * docs/285 — whether this deployment enforces containment, and when it does not,
 * **which** of the two very different reasons applies.
 *
 *  - `active` — enforcement is on and the sidecar image is configured. A
 *    Contained session is actually contained.
 *  - `disabled` — an operator set `SESSION_EGRESS_ENFORCE=0`. A Contained
 *    session **starts, and runs with open egress**, whatever the UI says.
 *  - `no-sidecar` — enforcement is on but `SESSION_EGRESS_SIDECAR_IMAGE` is
 *    unset, so the install gate fails closed and a Contained session **will not
 *    start at all**.
 *
 * The two inactive cases have opposite consequences — silently open versus
 * refusing to start — which is exactly why `enforcementActive: boolean` is not
 * enough to write a warning from: it forces copy that either overstates one case
 * or asserts neither. The UI names the case and its remediation inline.
 */
export type EgressEnforcementStatus = "active" | "disabled" | "no-sidecar";

/**
 * Global egress containment settings surfaced to the browser Settings panel.
 * `globalEnabled` is the default-on containment switch (true = Contained =
 * default-deny + allowlist + prompts; false = Open = unrestricted egress).
 * `globalHosts` is the user-managed allowlist (in addition to the built-in base
 * list, operator extras, and live MCP hosts).
 */
export interface EgressSettings {
  globalEnabled: boolean;
  globalHosts: string[];
  /**
   * Whether this deployment can actually ENFORCE containment, as opposed to the
   * `globalEnabled` *policy* switch. True only when egress enforcement is on
   * (`SESSION_EGRESS_ENFORCE !== "0"`) AND the privileged sidecar image is
   * configured (`SESSION_EGRESS_SIDECAR_IMAGE`). When `globalEnabled` is true but
   * this is false the UI must warn ("Contained — NOT enforced on this deployment")
   * rather than show a reassuring green state: the policy says contain, but a
   * session would fail closed (or, if disabled, run open) instead of being
   * contained. Distinguishes policy from enforcement (docs/172, planning#92).
   */
  enforcementActive: boolean;
  /**
   * docs/285 — WHICH deployment this is when `enforcementActive` is false, since
   * the two cases point in opposite directions. `enforcementActive` is kept
   * beside it rather than derived away: it is what every existing reader uses,
   * and one of them is an older client that will never know this field exists.
   */
  enforcementStatus: EgressEnforcementStatus;
}

/**
 * A session's egress view: the resolved containment plus its own override and
 * per-session extra hosts. `override` is `null` when the session inherits the
 * global switch, `true`/`false` when it forces Contained/Open.
 */
export interface EgressSessionSettings {
  sessionId: string;
  override: boolean | null;
  hosts: string[];
  /** Resolved containment after applying override over global. */
  effectiveContained: boolean;
  /** The current global switch, for rendering the "inherits global" state. */
  globalEnabled: boolean;
  /**
   * Whether this deployment can actually ENFORCE containment (see
   * {@link EgressSettings.enforcementActive}). When `effectiveContained` is true
   * but this is false, the session shows "Contained — NOT enforced on this
   * deployment": policy says contain but the container would fail closed at start.
   */
  enforcementActive: boolean;
  /** docs/285 — see {@link EgressSettings.enforcementStatus}. */
  enforcementStatus: EgressEnforcementStatus;
  /**
   * docs/172 — the resolved containment the session's LIVE container actually
   * started with (the egress topology — firewall/resolver/proxy sidecars — is
   * installed into the netns at container *creation*; flipping the mode on a
   * running session only persists the override, it does not re-plumb the live
   * container). `null` when no running container exists (nothing to compare /
   * restart). The client compares this against `effectiveContained` to know a
   * mode change is pending a restart.
   */
  startedContained: boolean | null;
  /**
   * docs/172 — true when `startedContained` is known and differs from
   * `effectiveContained`: the selected mode resolves to a different containment
   * outcome than the running container was started with, so it applies only on
   * the next container start. Drives the dialog's "Pending · applies on next
   * container start" indicator + "Restart to apply now" action.
   */
  pendingRestart: boolean;
}

/**
 * Where an effective-allowlist entry comes from. Only the two `user-*` sources
 * are user-editable; the rest are derived and shown read-only so the editor can
 * explain *why* a host is reachable.
 *   - `builtin`      — the always-on base list (agent APIs, git host, registries).
 *   - `operator`     — the deployment's `SESSION_EGRESS_ALLOWLIST` env.
 *   - `mcp`          — a connected MCP server / OAuth provider host.
 *   - `user-global`  — added by the user via the Settings allowlist editor.
 *   - `user-session` — added by the user for one session (per-session override).
 */
export type EgressAllowlistSource = "builtin" | "operator" | "mcp" | "user-global" | "user-session";

/** One row of the effective allowlist, with provenance + whether it's removable. */
export interface EgressAllowlistEntry {
  host: string;
  source: EgressAllowlistSource;
  /** True only for `user-global` / `user-session` — built-ins/MCP/operator are read-only. */
  removable: boolean;
}

// ---- Can a host be made reachable at all, and by whom (planning#383) ----

/**
 * The answer to ONE question about one host in one session: **can this host be
 * made reachable, and by whom?** Every surface that reports on a declared or
 * denied host reads this verdict, and nothing re-derives its own.
 *
 * It exists because three defects came out of the same requirement (docs/262
 * req 24 — enforcement and the card must not disagree) and differed only in what
 * the reporting side was optimistic ABOUT: a compose file (planning#377), a
 * session (planning#380), a deployment (planning#383). Three predicates that
 * each get one case right is the defect pattern, so there is one:
 * `orchestrator/egress-host-reach.ts`.
 *
 *  - `allowed` — reachable as things stand. Nothing to grant.
 *  - `grantable` — not reachable, and a USER act closes it: adding the host for
 *    this session or for the whole instance takes effect. This is the only
 *    verdict that may render a grant button.
 *  - `blocked-by-session` — no user grant can work HERE: this session's own
 *    resolved policy carries no user hosts at all (docs/211's Network-off
 *    sandbox, whose `network` capability only ever tightens). The entry saves
 *    and stays inert; another session on the same deployment is unaffected.
 *  - `blocked-by-deployment` — no user grant can work in ANY session on this
 *    deployment: with `SESSION_EGRESS_DNS=0` there is no Tier B resolver and no
 *    Tier C proxy, so a contained session reaches the fixed Tier A IP floor and
 *    nothing else, however the allowlist reads. Only an operator can change it.
 *
 * The two `blocked-*` verdicts are the ones a button may never sit on: every
 * button there writes a durable entry that changes nothing.
 */
export type EgressHostReach = "allowed" | "grantable" | "blocked-by-session" | "blocked-by-deployment";

// ---- What an allowlist ADD actually took effect on (planning#376) ----

/**
 * One class of surface an allowlist add either has already reached or has not.
 *
 *  - `new-containers` — anything created from now on reads the live config, so
 *    it starts with the new host: a fresh session container, and notably a
 *    plugin's companion-CLI or install container, which is created per
 *    invocation (`plugin-egress.ts`).
 *  - `agent` — the session's agent container. Its Tier B resolver and Tier C
 *    proxy are launched with a snapshot taken at container creation, so it is
 *    reached live only by a `reloadEgress` (a session-scoped add), never by a
 *    global one.
 *  - `services` — the session's running Compose services, re-contained by the
 *    same `reloadEgress` and otherwise stale until they restart.
 */
export type EgressGrantSurface = "new-containers" | "agent" | "services";

/**
 * planning#376 — what an allowlist add took effect on, reported BY the route
 * that performed it.
 *
 * The two scopes behave very differently (a session add reloads the live
 * resolver, proxy and every running service; a global add reloads nothing), and
 * predicting that in a tooltip beforehand was both unreachable after the click
 * and wrong. The server knows which reload it ran and what is running, so it
 * says so; the client renders this rather than re-deriving it from the scope,
 * which would be a second source of truth for one answer.
 *
 * `liveNow` and `staleUntilRestart` are disjoint, and a surface absent from both
 * is one this outcome makes no claim about.
 */
export interface EgressHostGrantOutcome {
  /** The host as the user gave it, for the confirmation sentence. */
  host: string;
  /** Where the entry was written — this session's extras, or the instance. */
  scope: "session" | "global";
  /** Surfaces already running the new allowlist. */
  liveNow: EgressGrantSurface[];
  /** Surfaces that keep the OLD allowlist until their next start. */
  staleUntilRestart: EgressGrantSurface[];
  /**
   * The session whose container restart would bring `staleUntilRestart` in
   * step, when one is in scope and there is something to fix. `null` means the
   * client must not offer a restart: nothing is stale, or the add was made
   * where no single session is in scope (the global Settings editor), where
   * "restart" has no unambiguous subject.
   */
  restartSessionId: string | null;
  /**
   * {@link EgressHostReach} for this host, from the one predicate every host
   * surface reads (`egress-host-reach.ts`) — so what the Plugins card said
   * BEFORE the click and what this outcome says after it cannot disagree.
   *
   * Either `blocked-*` verdict means the entry was saved and still reaches
   * nothing here: `blocked-by-session` for docs/211's Network-off sandbox
   * (another session on this deployment is fine), `blocked-by-deployment` for a
   * deployment that installs no resolver or proxy (no session is fine). Both
   * empty the surface lists and offer no restart, because no restart helps.
   */
  reach: EgressHostReach;
}

/**
 * `POST /api/egress/hosts` — the scope's refreshed settings view (unchanged, so
 * existing readers keep working) plus what the add actually took effect on.
 */
export type EgressHostAddResponse = (EgressSettings | EgressSessionSettings) & {
  grant: EgressHostGrantOutcome;
};

/**
 * The full effective-allowlist view for the Settings editor: every host the
 * session can reach (with provenance), the global containment toggle, and — when
 * a session is in scope — that session's override + resolved containment.
 */
export interface EgressAllowlistView {
  entries: EgressAllowlistEntry[];
  globalEnabled: boolean;
  /**
   * Whether this deployment can actually ENFORCE containment (see
   * {@link EgressSettings.enforcementActive}). Carried at the top level so the
   * global-only view (no session in scope) can still render the policy-vs-
   * enforcement warning.
   */
  enforcementActive: boolean;
  /** docs/285 — see {@link EgressSettings.enforcementStatus}. */
  enforcementStatus: EgressEnforcementStatus;
  /** The in-scope session's settings, or null for the global-only view. */
  session: EgressSessionSettings | null;
  /** True when the user has removed any built-in default (drives "Restore defaults"). */
  defaultsCustomized: boolean;
}
