// ---- Agent types (multi-agent support) ----

import type { EventEmitter } from "node:events";
import type { ImageAttachment, PermissionMode } from "./attachment-types.js";
import type { ApiStyle, BillingMode, CredentialTarget } from "../catalogue/types.js";
import type { McpServerConfig, McpServerStatus } from "./mcp-types.js";

// ---- Agent identity ----

export type AgentId = "claude" | "codex" | "opencode" | "grok";

/**
 * The permission modes the Claude Code adapter supports (docs/138). Single
 * source of truth shared by the session adapter (`claude-adapter.ts`) and the
 * orchestrator-side static registry (`agent-registry.ts`) so the two can't
 * drift. `guarded` is the classifier-gated mode (CLI `--permission-mode auto`).
 */
export const CLAUDE_PERMISSION_MODES: PermissionMode[] = ["auto", "plan", "guarded"];

/**
 * The permission modes the Grok Build adapter supports (docs/274).
 *
 * Deliberately its **own** constant rather than a reference to
 * {@link CLAUDE_PERMISSION_MODES}, even though the two currently hold the same
 * three values: what they state is not the same fact. Grok's CLI has a *wider*
 * native set than Claude's (`default | acceptEdits | auto | dontAsk |
 * bypassPermissions | plan`), and this list is the subset ShipIt's three-mode
 * vocabulary maps onto — `plan` → `--permission-mode plan`, `guarded` →
 * `--permission-mode auto` (Grok's classifier-gated mode, the same spelling
 * Claude uses), `auto` → `--always-approve`. Sharing Claude's constant would
 * make a later divergence in either CLI silently change the other's row.
 */
export const GROK_PERMISSION_MODES: PermissionMode[] = ["auto", "plan", "guarded"];

// ---- Agent capabilities ----

/**
 * Reasoning/effort options an agent exposes. The control's name and value set
 * differ per agent (Claude Code `--effort`: low…max; Codex
 * `model_reasoning_effort`: none…xhigh), so the registry owns the per-agent
 * values and the client renders them. A stored selection absent from this set —
 * or no stored selection at all — means "pass no flag", i.e. the CLI's native
 * default. See docs/217-per-agent-reasoning.
 */
export interface AgentReasoningCapability {
  /** Control label, e.g. "Reasoning" (claude) or "Reasoning effort" (codex). */
  label: string;
  /**
   * The harness's VOCABULARY: every effort level this CLI understands, with the
   * label each renders under. Does NOT include the implicit "Default"/no-flag
   * entry.
   *
   * Naming a level here says the CLI accepts the word — **not that every
   * selection honours it**. That second question is {@link billingModes} and
   * `ModelDef.reasoningEfforts`, and the three compose in
   * `catalogue/index.ts`'s `reasoningOptionsFor`, which is the only honest
   * answer to "what goes in the picker".
   */
  options: { value: string; label: string }[];
  /**
   * docs/274 req 14 — the billing modes under which this harness's CLI actually
   * SENDS the level, when that is not all of them. Absent means all of them,
   * which is every harness but one.
   *
   * The axis exists because grok needs it and neither of the other two can
   * express it. `--reasoning-effort` reaches the wire when xAI's SUBSCRIPTION
   * catalogue authenticated the CLI and is silently discarded under an API key
   * — both recorder-verified with a negative control (docs/274 Resolved
   * questions). That gate is the billing mode and nothing else:
   *
   *   - **Per-harness ({@link options}) cannot say it.** One list must either
   *     offer four levels that do nothing under a key, or hide four that work
   *     under a subscription.
   *   - **Per-row (`ModelDef.reasoningEfforts`) cannot say it either**, and
   *     this is the part that looks like it could. A `ModelDef` is per
   *     *(service, mode, model)* and NOT per harness, while grok shares gateway
   *     rows (`x-ai/grok-4.6` at OpenRouter and Vercel, DeepSeek and GLM via
   *     chat-completions) with three harnesses that DO honour levels there. On
   *     such a row `[]` strips the levels from those three and absent leaks
   *     grok's four onto a row that drops them — there is no value that is
   *     right for all four at once.
   *
   * So the row field keeps the job only it can do — narrowing WITHIN a mode,
   * where `grok-4.6` offers `xhigh` and `grok-4.5` does not — and this field
   * carries the mode gate. Stated as the modes that DO honour it rather than
   * the ones that do not, so the default (absent) is the permissive, correct
   * answer for a harness with no such split.
   */
  billingModes?: BillingMode[];
}

/*
 * docs/261's `SUB_AGENT_ROLES` — a compiled-in list of the roles that exist —
 * is **deleted** here rather than extended (docs/264-agent-roles reqs 13, 18). A role is now
 * any name the user typed, stored server-side, so no constant can hold the set
 * and every caller that checked against one was rejecting the user's own roles.
 * The name that remains constant is the reserved one: {@link RESERVED_ROLE_NAME},
 * below. Resolution — and the refusal that names the roles that do exist — is
 * `services/roles.ts`'s.
 */

/**
 * docs/264-agent-roles req 10 — any subset of a role's parameters, named by the caller at
 * the moment it starts one.
 *
 * Every field optional, and that is req 16's "partial is the normal case": a
 * caller names what it cares about and the **base** supplies the rest. The empty
 * object is the ordinary path — a bare role name, nothing overridden.
 *
 * Shared rather than orchestrator-local because {@link SpawnTarget} carries it
 * over the wire, and a second declaration is how the two come to disagree about
 * a field.
 */
export interface RoleOverrides {
  harnessId?: AgentId | undefined;
  serviceId?: string | undefined;
  billingMode?: BillingMode | undefined;
  modelId?: string | undefined;
  reasoningEffort?: string | undefined;
}

/**
 * docs/264-agent-roles req 16 — what a spawn runs on, in the one vocabulary **both** spawn
 * commands speak.
 *
 * The shape is always *a base plus overrides*, and the three kinds are the three
 * bases:
 *
 *  - **`role`** — a role by name (reqs 3, 4), with any subset of its parameters
 *    overridden (req 10). Available to both commands. The role supplies
 *    everything the caller did not name; for the shipped reviewer ShipIt
 *    resolves the params instead (req 2).
 *  - **`explicit`** — no base at all, so the call must name every parameter the
 *    named harness has: the four identity flags always, the reasoning level
 *    exactly where the harness declares levels (docs/275 req 2). Available to
 *    both commands. Kept implemented for a repository that holds a complete
 *    target of its own (req 15), and no longer the shape ShipIt teaches.
 *  - **`inherit`** — the **parent session** is the base (`shipit session create`
 *    only, because a one-shot run has no parent). This is the shipped
 *    `--model X` form docs/261 req 10 guarantees, and it is now one of the
 *    general cases rather than an exception.
 *
 * **The surface is unified; the completion semantics are NOT.** A parent does
 * not complete a partial call the way a role does — a model id names one
 * backend's catalogue, so it carries no service, and a harness switch clears the
 * inherited selection entirely. Those rules are docs/261's and stay exactly as
 * they are (`services/child-sessions.ts`); this type says only that the two
 * commands *accept* the same things.
 */
export type SpawnTarget =
  | {
      kind: "role";
      /** Any name the user typed (req 18) — resolved server-side, never checked against a list. */
      role: string;
      overrides: RoleOverrides;
    }
  | {
      kind: "explicit";
      /** The harness that runs (docs/261 req 3's `--agent`). */
      harnessId: AgentId;
      /** The `(service, billing mode, model)` triple that identifies a model. */
      serviceId: string;
      billingMode: BillingMode;
      modelId: string;
      /**
       * The reasoning level — part of the call, never the harness's default,
       * wherever the harness declares levels. A harness that declares none has
       * no level parameter at all (docs/275 req 2), so the field is absent
       * there — and only there: `resolveSpawnTarget` refuses an omission on a
       * level-having harness and a named level on a level-less one.
       */
      reasoningEffort?: string;
    }
  | {
      kind: "inherit";
      overrides: RoleOverrides;
      /**
       * docs/264-agent-roles req 20 — the caller declined the parent's role
       * (`--no-role`). The child still inherits the parent's parameters; what it
       * does not inherit is the role's name and its standing instructions.
       *
       * Absent is the default, which inherits the role whole. The flag exists so
       * that a session working under a brief can still spawn a child for
       * something else — a brief that cannot be declined is not a default.
       */
      noRole?: boolean;
    };

/**
 * What a **one-shot** `shipit agent run` runs on: {@link SpawnTarget} minus the
 * parent base, which it has no access to.
 *
 * Expressed as a narrowing rather than a second union so the one place the two
 * commands differ is stated once, in the type, exactly as req 16 states it.
 */
export type SubAgentSpawnTarget = Extract<SpawnTarget, { kind: "role" | "explicit" }>;

/**
 * docs/261 req 4 — which of the two configured reviewers a slot is.
 *
 * The order is the user's, and it is load-bearing in exactly two places: it
 * breaks a tie when both reviewers are equally distant from the implementer, and
 * it is what reviewer 2 is derived *against* when neither slot is pinned. It is
 * NOT a preference — the ranking picks whichever is furthest, so `second` beats
 * `first` routinely.
 */
export type ReviewerSlot = "first" | "second";

/** Both slots, in the user's own order. Iterate this rather than re-listing them. */
export const REVIEWER_SLOTS: readonly ReviewerSlot[] = ["first", "second"];

/**
 * docs/261 reqs 1, 3, 5 — a reviewer the user pinned: a model like any other
 * (`(service, billing mode, model)`, req 3) plus the reasoning level (req 5).
 *
 * **The harness is absent on purpose.** Req 3 keeps it derived from the model,
 * exactly as background work already resolves it — and docs/261 derives it with
 * one extra preference (avoid the implementer's), so storing it would freeze an
 * answer that has to be recomputed per review anyway.
 *
 * **`reasoningEffort` is present exactly when the derived harness declares
 * levels, and that is the type-level statement of "pinning is atomic".**
 * Editing any field of an auto-configured slot pins the whole resolved tuple; a
 * half-pinned slot — a pinned effort over a derived model — is not expressible,
 * because the alternative is a slot that silently re-derives half of itself when
 * a service is added. A reviewer that left the level to the harness's own
 * default would also fail req 5 outright.
 *
 * It became optional in docs/274 and the reason is narrow: Grok Build is the
 * first harness that declares NO reasoning levels (`reasoning.options: []` — in
 * API-key mode the CLI silently drops `--reasoning-effort`). Absent here means
 * "this harness has no level to pin", never "the user did not choose one" —
 * naming a level on a harness that declares none is still refused, and omitting
 * one on a harness that declares some is still an incomplete pin. Both halves
 * are enforced in `reviewer-settings.ts`, because a type cannot say "required
 * iff a sibling field's harness declares levels".
 */
export interface ReviewerPin {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /** A value from the derived harness's `reasoning.options`; absent iff it declares none. */
  reasoningEffort?: string;
}

/**
 * docs/261 phase 3 (req 8) — the complete reviewer a slot currently resolves to.
 *
 * Lives beside {@link ReviewerPin} rather than in the orchestrator's service
 * types because the browser renders it verbatim: it is a wire shape, and the
 * client re-typing it inline is how the two come to disagree about a field.
 */
export interface ReviewerResolved {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  serviceName: string;
  /** Model label, not the raw id — the same string the picker shows. */
  label: string;
  /** Derived (req 3), never stored. */
  harnessId: AgentId;
  harnessName: string;
  /**
   * Req 5 — the pin's level, or the review default derived for what this slot
   * resolved onto. Absent only for a selection that offers no level (docs/274).
   */
  reasoningEffort?: string;
  /** That level's display label on this selection, when there is one. */
  reasoningLabel?: string;
  /**
   * planning#352 — every harness this reviewer could resolve onto that does
   * **not** offer the pinned level, and what a review there runs at instead.
   *
   * Present only on a pinned slot, and empty (omitted) when the pin applies
   * everywhere. It exists because a pin is applied *partially*: the pinned model
   * is kept and the level is re-derived per resolution, so the tab has to say
   * what the level became rather than report a pin that is not in force. The
   * harness this view names is included when it is one of them — the tab names
   * ONE harness while a review derives its own, so a note scoped to the tab's
   * own resolution would stay silent about the crossing that made this a defect.
   */
  effortSubstitutions?: ReviewerEffortElsewhere[];
}

/** planning#352 — one harness a pinned level does not survive onto. */
export interface ReviewerEffortElsewhere {
  harnessId: AgentId;
  harnessName: string;
  /** What a review there runs at; absent when that row carries no level at all. */
  reasoningEffort?: string;
  reasoningLabel?: string;
}

/**
 * docs/261 phase 3 (req 8) — one reviewer slot as the Settings screen sees it.
 *
 * Both halves ride together and neither is derivable from the other: `pin` is
 * what the user chose (absent when the slot is auto-configured), and `resolved`
 * is what the slot runs on **right now**. The server computes `resolved`,
 * because the derivation is reqs 4/8's rule and a second implementation in the
 * browser is how the setting starts disagreeing with what actually reviews.
 */
export interface ReviewerSlotView {
  slot: ReviewerSlot;
  /** Req 8's visible state: `pinned` is a choice the user made, `auto` re-derives. */
  source: "pinned" | "auto";
  /** The stored pin, present exactly when `source === "pinned"`. */
  pin?: ReviewerPin;
  /**
   * What this slot resolves to today, harness and reasoning level included
   * (req 5 — a derived reviewer is complete). Absent when nothing runnable
   * answers it, which {@link ReviewerSlotView.unavailableReason} explains.
   */
  resolved?: ReviewerResolved;
  /**
   * Why there is no `resolved`. `pin_unavailable` means the user's choice lost
   * its credential or its harness; `nothing_eligible` means the install has
   * nothing to run a review on at all. They read very differently to the user,
   * so they are not collapsed into one absence.
   */
  unavailableReason?: "pin_unavailable" | "nothing_eligible";
}

/**
 * docs/261 phase 3 — a pin edit arriving on `PUT /api/settings`.
 *
 * `reasoningEffort` is optional **here and nowhere else**: the stored pin is
 * always complete (req 5), and omitting the level on the wire means "the model
 * changed, give me this harness's default" — which the server answers, because
 * the harness is its derivation and the client must not re-derive it. The
 * response carries the resulting complete pin, so nothing is filled in
 * somewhere the caller cannot see.
 */
export interface ReviewerPinPatch {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  reasoningEffort?: string;
}

// ---- Agent roles (docs/264 phase 1) ----------------------------------------

/**
 * docs/264-agent-roles req 2 — the one role name ShipIt owns.
 *
 * Reserved rather than seeded: {@link RoleAutoParams} is rejected for every
 * other name, this one cannot be renamed or deleted, and `getRoles()`
 * synthesizes it even on a completely empty store. "Review this" therefore
 * always has something to resolve to, including on an install nobody has
 * configured.
 *
 * **Reservation is an exact-string match, not a case-insensitive one.** Req 18
 * says a role may be any name the user types, with only uniqueness enforced and
 * explicitly "no case rule" — so `Reviewer` is a different name and an ordinary
 * pinned role. Folding case here would be a restriction nobody asked for, on
 * the one requirement that says not to add restrictions.
 */
export const RESERVED_ROLE_NAME = "reviewer";

/**
 * docs/264-agent-roles reqs 1, 6 — a role whose params the **user** pinned: the complete
 * tuple, the harness included.
 *
 * `harnessId` is the departure from {@link ReviewerPin}, which deliberately
 * omits it (docs/261 req 3 derives the harness from the model): a role is a *job
 * definition*, and which agent performs the job is part of the job — Claude Code
 * driving a model and Codex driving the same model are different agents. Stored
 * and frozen, never re-derived per run, so a role whose harness is uninstalled
 * reports that it cannot run rather than quietly running on another one.
 *
 * **`reasoningEffort` is optional, and absent means `Default`** — the level the
 * named harness runs at when ShipIt passes no flag, exactly as it already means
 * in {@link AgentSpawnOptions} and in the composer's own picker
 * (`ReasoningSelector.tsx`, where `Default` has been a listed, selectable option
 * since docs/217).
 *
 * This does not weaken req 1's "a role is complete on its own". `Default` is a
 * choice the user makes and ShipIt records, not a blank: starting such a role
 * still needs nothing added to it (req 4), and ShipIt still substitutes nothing
 * (req 7) — it passes no flag, which is what the role says to do. What made the
 * level *look* required was the storage encoding (no flag ⇒ no value), and an
 * editor built on that encoding offered a different option list from the
 * composer for the same knob. See docs/264 req 1's resolved question.
 *
 * **This subsumes docs/274 req 8 rather than competing with it.** That rule
 * reached the same optionality from the other end — a harness declaring no
 * reasoning levels has no level for a role to carry, and refusing to define a
 * role on it at all would be a restriction req 1 never asked for. Such a role is
 * at `Default`, because `Default` is the only thing it can be; the difference is
 * that absent is now legal on *every* harness, not only that one. What docs/274
 * kept as a refusal is kept: naming a level on a harness that declares none is
 * still false about the harness.
 *
 * Contrast {@link ReviewerPin}, where the level stays required: ShipIt derives
 * the reviewer's harness **per review**, so `Default` there would name no
 * harness and could mean a different level on each run. A pinned role names its
 * harness (req 6), so its `Default` is unambiguous.
 */
export interface RolePinnedParams {
  kind: "pinned";
  /** The harness that runs this role (req 6). Required, stored, never derived. */
  harnessId: AgentId;
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /**
   * A level the *named* harness declares — validated against that one, not a
   * derived one. Absent ⇒ `Default`: pass no flag, and let the harness use its
   * own level. Always legal, including on a harness that declares no levels at
   * all (docs/274 req 8), where it is the only possibility.
   */
  reasoningEffort?: string;
}

/**
 * docs/264-agent-roles req 2 — params ShipIt resolves per run, rather than params the user
 * pinned. The shipped reviewer's, and **only** the shipped reviewer's.
 *
 * It carries no fields because there is nothing to carry: the answer is
 * docs/261's two ranked candidate slots, resolved against whatever is
 * implementing at the moment the review is asked for. "Use whoever is furthest
 * from the model that wrote this" is a rule evaluated per run, and no fixed set
 * of params can encode it — which is the whole and only reason this
 * discriminator exists.
 */
export interface RoleAutoParams {
  kind: "auto";
}

/** One role's params — pinned by the user (req 1), or resolved by ShipIt (req 2). */
export type RoleParams = RolePinnedParams | RoleAutoParams;

/**
 * docs/264 — a named unit of agent work (reqs 1, 2, 6, 8, 9).
 *
 * **There is one kind of role.** The variation lives in {@link RoleParams}, not
 * in two shapes of object: the reviewer is named, started, refused and reported
 * exactly as every other role is, and differs only in that ShipIt supplies its
 * params. That is what keeps one store, one lookup, one refusal and one
 * attribution path.
 */
export interface AgentRole {
  /**
   * Any name the user typed (req 18). Unique, non-blank, and bounded only by
   * what storage needs — no token shape, no case rule. A name that needs quoting
   * on a command line is quoted, exactly as a session title already is.
   */
  name: string;
  /** Req 9 — what the role is for, in one short line. Optional; the name is the fallback. */
  description?: string;
  /** Req 8 — standing instructions, joined with the run's own task at spawn. Optional. */
  prompt?: string;
  params: RoleParams;
}

/**
 * Why a role cannot run right now. **Three states, not two**, because the remedy
 * differs in each and collapsing them sends the user to the wrong place.
 *
 *  - `stranded` — its model, service or harness no longer exists, or the pair
 *    no longer agrees. It needs a **Settings edit**, and is never silently
 *    repaired: req 7 rules out re-pointing it, including through a catalogue
 *    retirement successor. The role's own fault, and the only one of the three
 *    that is.
 *  - `disconnected` — the tuple is still structurally valid, but the service it
 *    names has no usable credential any more. The remedy is to **reconnect the
 *    service**; telling the user to edit a perfectly good role would be wrong.
 *    Route selection reports this as `auth_required`.
 *  - `quota_exhausted` — the subscription is spent. Nothing to fix; it recovers
 *    when the quota resets, and the tuple is kept exactly. Route selection
 *    reports this as `all_exhausted`.
 */
export type RoleUnavailableReason = "stranded" | "disconnected" | "quota_exhausted";

/** What a pinned role resolves to today, with labels the Settings list renders. */
export interface RoleResolved {
  harnessId: AgentId;
  harnessName: string;
  serviceId: string;
  billingMode: BillingMode;
  serviceName: string;
  modelId: string;
  /** Model label, not the raw id — the same string the picker shows. */
  label: string;
  /** Absent ⇒ the role runs at `Default` (see {@link RolePinnedParams}). */
  reasoningEffort?: string;
  /** That level's display label on this harness, when the harness declares one. */
  reasoningLabel?: string;
}

/**
 * docs/264 phase 1 — one role as the settings payload carries it.
 *
 * **The server sends the resolution**, exactly as it does for a reviewer slot
 * and for the same reason: which harness runs a model and which levels it
 * declares are catalogue rules, and a second implementation in the browser is
 * how the Settings screen starts promising something other than what runs.
 *
 * `resolved` is absent for the reviewer, and that is not a gap. Its params are
 * docs/261's **two ranked candidate slots** rather than one tuple, and those
 * already ride the same payload as `reviewers` — a single `resolved` here would
 * have to pick one of the two and would misreport whichever it dropped.
 */
export interface RoleView {
  name: string;
  description?: string;
  prompt?: string;
  params: RoleParams;
  /** True for {@link RESERVED_ROLE_NAME} — it cannot be renamed or deleted (req 2). */
  reserved: boolean;
  /** What a pinned role runs on today. Absent when it cannot run, or for the reviewer. */
  resolved?: RoleResolved;
  /** Why there is no `resolved`, when the role is pinned and cannot run. */
  unavailableReason?: RoleUnavailableReason;
  /**
   * Which parameter is at fault, for `stranded` — the field the Settings edit has
   * to change. Names the parameter rather than describing the failure, because
   * that is what the editor highlights.
   *
   * All five of a role's parameters are nameable, so a service that has left the
   * catalogue is not reported as a bad *model*: rule (d) says the refusal names
   * the parameter, and an editor that highlighted the wrong field would send the
   * user to change something that is correct.
   *
   * Absent for `disconnected` and `quota_exhausted`, deliberately — the tuple is
   * intact in both, so there is no field to highlight and no edit to make.
   */
  invalidField?: "harnessId" | "service" | "billingMode" | "model" | "reasoningEffort";
  /** For `quota_exhausted`: when to try again, when routing could say. */
  earliestResetAt?: string | null;
}

/**
 * docs/264 phase 2 (reqs 5, 17, 18) — one role as an **edit** crosses the wire.
 *
 * A role is created, renamed, edited and deleted through the existing settings
 * mutation surface (`PUT /api/settings`), keyed by the name the role will have
 * afterwards, with `null` for a delete. The whole role is written at once
 * (req 17): the editor holds a name, a description, standing instructions and
 * five parameters, and saving it is one write rather than a control-by-control
 * trickle.
 *
 * **`previousName` is what distinguishes a create from an edit**, and the
 * distinction is req 18's uniqueness rule made checkable. Without it, "create a
 * role called `deep-dive`" and "edit the existing `deep-dive`" arrive as the
 * same request, so a create that collides with an existing name would silently
 * overwrite it instead of being refused. Absent means create; present names the
 * role being edited, and a `previousName` that differs from the key is a
 * rename — an ordinary validated write followed by a delete, since nothing holds
 * a reference to the old name.
 */
export interface RoleWrite {
  /** The role being edited, when one is. Absent ⇒ create; different from the key ⇒ rename. */
  previousName?: string;
  /** Req 9 — optional; an empty string clears it. */
  description?: string;
  /** Req 8 — optional standing instructions; an empty string clears them. */
  prompt?: string;
  params: RoleParams;
}

export interface AgentCapabilities {
  /** Whether the agent can resume a previous conversation (e.g. --resume). */
  supportsResume: boolean;
  /** Whether the agent accepts image attachments in prompts. */
  supportsImages: boolean;
  /** Whether the agent accepts an explicit system prompt. */
  supportsSystemPrompt: boolean;
  /** Whether the agent supports permission/sandbox modes. */
  supportsPermissionModes: boolean;
  /** Which permission modes are available (empty if unsupported). */
  supportedPermissionModes: PermissionMode[];
  /** Tool names the CLI exposes (for UI mapping). */
  toolNames: string[];
  /** Known model identifiers for this agent. */
  models: string[];
  /**
   * Reasoning/effort options this agent exposes, if any. Absent for agents with
   * no reasoning knob. See docs/217-per-agent-reasoning.
   */
  reasoning?: AgentReasoningCapability;
  /**
   * Whether the agent backend can run the chat-native AI review flow
   * (docs/125-chat-native-ai-review). The feature requires both a subagent
   * primitive and custom MCP tool registration; we collapse those two
   * requirements into a single feature-shaped flag because the AND is the
   * only thing we ever check. Claude Code: true. Codex: false. When a
   * future adapter can satisfy both, flip this on.
   */
  supportsReview: boolean;
  /**
   * Whether the agent supports live steering — injecting user messages mid-turn
   * or starting next turns without respawning. Claude uses --input-format
   * stream-json; Codex uses turn/steer. (docs/140)
   */
  supportsSteering: boolean;
  /**
   * Whether the backend's process stays resident BETWEEN turns and can start a
   * turn ShipIt never asked for — a `Bash(run_in_background)` job finishing
   * (docs/235), or a live steer it acked too late to apply to the finishing
   * turn (docs/140 Phase 6.11). The orchestrator adopts such a turn when it
   * sees top-level assistant output after a `result`, so this flag is what
   * keeps that inference off backends where the same shape means something
   * else.
   *
   * **Claude: true** — the streaming CLI is one resident process across turns.
   * **Codex: false** — the app-server is killed at `turn/completed`, and it
   * routinely emits the turn's FINAL assistant text *after* `turn/completed`
   * (see the `pendingCommitLink` comment in `agent-listeners.ts`). Those late
   * events belong to the turn that just ended; adopting them would mark the
   * session busy for a turn that will never produce another `result`.
   *
   * Deliberately NOT `supportsSteering`: both backends steer, but only one
   * survives its own turn boundary. Deliberately not read from
   * `AgentProcess.capabilities` either — `ProxyAgentProcess` hardcodes
   * defaults; resolve it through the agent registry, as `useStreaming` is.
   *
   * Optional, and absent means **false**: adoption is an inference about a
   * backend's process model, and a backend that has not declared one must not
   * have it guessed on its behalf.
   */
  startsOwnTurns?: boolean;
  /**
   * Whether the agent backend can compact its own context — both summarizing on
   * demand (the `/compact` composer command) and emitting native compaction
   * signals ShipIt renders inline (docs/178). Claude Code: true (the CLI's
   * `/compact` + `system/compact_boundary` stream events). Codex: true (the
   * app-server's `thread/compact/start` RPC + `contextCompaction` items). Gates
   * both the `/` autocomplete entry and the `agent.compact()` trigger path.
   */
  supportsCompaction: boolean;
  /**
   * Per-CLI dotfolder for project skills, e.g. `.claude` or `.codex`. Project
   * skills live at `<workspace>/<skillsDirName>/skills/<name>/SKILL.md` and the
   * marketplace installer writes here. Single source of truth so adding a new
   * backend (`.cursor`, `.gemini`) doesn't sprout new branches at every call
   * site. (docs/155)
   */
  skillsDirName: string;
  /**
   * Character the user types in chat to invoke a skill — Claude uses `/`,
   * Codex uses `$`. Read by the marketplace install service (to render the
   * invocation token in the install confirmation) and by the client's message
   * composer (to insert the right prefix when picking a skill from the menu).
   * (docs/138, docs/155)
   */
  skillInvocationPrefix: string;
}

// ---- Normalized event schema ----

/** Emitted once when the agent starts a conversation. */
export interface AgentInitEvent {
  type: "agent_init";
  agentId: AgentId;
  sessionId: string;
  model?: string;
  tools?: string[];
  /**
   * The permission mode the CLI actually engaged for this run, as reported by
   * the init event (docs/138). For Claude Code, `"auto"` here means the
   * classifier-gated guarded mode is live. If guarded was requested but this
   * reports anything else, guarded was unavailable (plan/admin/model
   * constraint) and the run silently dropped to default — the orchestrator
   * uses this as the authoritative availability signal. Undefined for adapters
   * that don't surface it.
   */
  permissionMode?: string;
}

/** An assistant turn — text and/or tool invocations. */
export interface AgentAssistantEvent {
  type: "agent_assistant";
  content: AgentContentBlock[];
  /**
   * When the agent emits this event from inside a subagent (e.g. Claude's Task
   * tool), this is the tool_use id of the parent Task call. Top-level
   * assistant events leave this undefined. The client uses it to render the
   * subagent's work as a nested tree under the parent Task tool call rather
   * than flattening it into the main conversation. (109 — subagent transparency)
   */
  parentToolUseId?: string;
  /**
   * When true, this event carries the FULL final text of a streamed assistant
   * message — used by adapters (Codex) that previously emitted incremental
   * deltas via individual `agent_assistant` events. The orchestrator uses this
   * as the authoritative `turnSummary` (single-line commit / activity label)
   * but does NOT append the text to `accumulatedText` or `chatMessageGroups`,
   * because the deltas already populated those. Without this signal,
   * `turnSummary` ends up as just the last delta (often a single character
   * like ".") which became the commit message.
   */
  isStreamCompletion?: boolean;
}

/** Tool results flowing back to the agent. */
export interface AgentToolResultEvent {
  type: "agent_tool_result";
  content: unknown[];
  /** See AgentAssistantEvent.parentToolUseId. */
  parentToolUseId?: string;
}

/** Final result of a turn. */
export interface AgentResultEvent {
  type: "agent_result";
  status: "success" | "error";
  sessionId: string;
  cost?: { totalUsd: number };
  /**
   * Turn-wide token totals — these are SUMS across every API call (iteration)
   * in the turn. Use them for cost/billing rollups, NOT for "current context
   * size" (which would be over-counted by N× for an N-iteration turn). The
   * authoritative context-occupancy reading is `contextTokens` below.
   */
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /**
   * Real context-window occupancy at turn end: input + cache_read + cache_create
   * from the LAST API call in the turn. The Claude CLI exposes this via
   * `result.usage.iterations[]`. For single-call turns this equals the sum;
   * for multi-call (tool-use) turns it is dramatically smaller. Drives the
   * context dial. Adapters that can't break down per-iteration leave this
   * undefined and the client falls back to summing.
   */
  contextTokens?: number;
  /**
   * Model's context window in tokens, as reported by the backend's
   * `result.modelUsage[<model>].contextWindow`. Preferred over ShipIt's
   * static `MODEL_CONTEXT_WINDOWS` map so models like Opus 4.7 (1M window)
   * automatically get the right denominator. Undefined when the adapter
   * can't surface it.
   */
  contextWindow?: number;
  durationMs?: number;
  error?: string;
  /**
   * Tool calls the guarded-mode classifier blocked during this turn (docs/138).
   * Each entry is one blocked call. A single block does NOT abort the turn (the
   * model re-routes); the Claude CLI aborts a headless (`-p`) run only after its
   * 3-consecutive / 20-total threshold. The orchestrator surfaces the denial
   * reason(s) inline so a guarded turn never fails silently. Empty/undefined
   * when nothing was blocked. Note: model self-refusals are NOT classifier
   * denials and never appear here.
   */
  permissionDenials?: { toolName: string; toolUseId?: string; toolInput?: unknown }[];
}

/**
 * Subscription rate-limit snapshot pushed by an agent backend mid-turn.
 *
 * - **Codex** emits this from the `account/rateLimits/updated` JSON-RPC
 *   notification its app-server streams — same numbers it draws its own
 *   `/status` line from. Both windows arrive in a single event.
 * - **Claude** emits it from the CLI's `rate_limit_event` stream messages
 *   (under `--output-format=stream-json`), which the CLI itself derives
 *   from Anthropic's `anthropic-ratelimit-unified-*` API response headers.
 *   The CLI emits one window per event, so `ClaudeAdapter` accumulates the
 *   last-known five_hour + seven_day and re-emits this combined shape on
 *   every change.
 *
 * The orchestrator routes both into the subscription-limits badge via
 * `recordAgentRateLimits` (see index.ts and the per-provider
 * `setRateLimits()` methods). Percentages are 0–100; `resetAt` is an ISO
 * timestamp. Either window may be null when the backend has only ever
 * reported one.
 */
export interface AgentRateLimitsEvent {
  type: "agent_rate_limits";
  /**
   * Rolling short-window quota (Claude: 5h, Codex: 5h). `usedPct` is null
   * when the provider only reported the window's existence and its reset
   * time but not the utilization (Claude CLI 2.1.140 does this below its
   * warning thresholds — see anthropics/claude-code#50518).
   */
  session: { usedPct: number | null; resetAt: string } | null;
  /** Weekly quota. */
  weekly: { usedPct: number | null; resetAt: string } | null;
}

/**
 * A live-steer (`turn/steer` for Codex, NDJSON user-message for Claude) the
 * backend refused to apply mid-turn. Codex rejects steering during **review**
 * and **manual compaction** turns (`ActiveTurnNotSteerable`); rather than let
 * the message vanish (it was already optimistically rendered), the adapter
 * emits this so the orchestrator can fall back to the queue and run it as the
 * next turn. `text` is the steer payload the adapter attempted to send.
 * (docs/140)
 */
export interface AgentSteerRejectedEvent {
  type: "agent_steer_rejected";
  text: string;
}

/**
 * docs/140 — a live steer's **delivery acknowledgment**: the backend confirmed
 * it accepted the steered user message into the running turn.
 *
 * - **Claude** emits this from its `--replay-user-messages` echo of an injected
 *   user message (`isReplay:true`). The echo fires for every accepted user
 *   message (including the turn's initial prompt), so the orchestrator matches
 *   `text` against the steer it sent rather than assuming every replay is a steer.
 * - **Codex** emits this when its `turn/steer` JSON-RPC request *resolves*
 *   (the app-server accepted the steer). A rejected `turn/steer` instead emits
 *   {@link AgentSteerRejectedEvent}.
 *
 * Either way the orchestrator marks the matching steer `delivered` so it is not
 * re-queued at turn end. An un-acked steer (one that fell into the turn-end gap)
 * IS re-queued.
 *
 * A live steer is written to the resident process's stdin while `running` is
 * still `true`, but the CLI only applies a steered message at its next decision
 * point (a tool return). A steer injected while the model is *wrapping up* has
 * **three** possible outcomes, not two:
 *
 *   1. **It lands in the turn.** The model reaches a decision point, acts on it,
 *      and the CLI echoes it — the ordinary case.
 *   2. **It is silently lost.** There is no next decision point left, the turn
 *      ends with a `result`, and no echo ever arrives. The message would stay in
 *      the transcript with the agent never acting on it, so the orchestrator
 *      re-queues every steer NOT echoed before the `result` and runs it as a
 *      fresh turn instead (`requeueUndeliveredSteers`).
 *   3. **The CLI takes it and runs it as its OWN turn after the `result`.** The
 *      echo fires — the CLI accepted the message — but the model applies it in a
 *      turn that starts *after* the orchestrator has finalized the current one.
 *      The message is neither lost nor part of the finishing turn, so it must
 *      NOT be re-queued (that would double-process it); instead the orchestrator
 *      adopts the follow-on turn when that turn produces its first top-level
 *      assistant output (`adoptCliStartedTurn` in `agent-listeners.ts`). Nothing
 *      announces it — the CLI's `init` is emitted for `set_permission_mode` too,
 *      with no turn behind it — so the model talking is the first proof it
 *      exists. Observed in production 2026-08-13: the session read as idle for
 *      5.5 minutes while the agent worked, with no post-turn commit armed for
 *      its edits.
 *
 * So this ack means "the CLI received it", not "the model applied it in the
 * finishing turn" — outcome 3 is exactly where those two come apart.
 *
 * `text` is the echoed user-message text (the assembled prompt the CLI
 * received). NOT chat content — `agent-listeners` consumes it for ack tracking
 * and returns before the message accumulator (like `agent_steer_rejected`).
 */
export interface AgentUserReplayEvent {
  type: "agent_user_replay";
  text: string;
}

/**
 * docs/178 — a context compaction has *started*. Transient progress only: the
 * orchestrator forwards it as an emit-only "Compacting…" indicator and never
 * persists it (it has no place in the scrollback once the matching
 * {@link AgentCompactedEvent} card lands). Both CLIs may compact unsolicited
 * mid-turn, so this can arrive without ShipIt having triggered it.
 *
 * - **Claude**: mapped from the CLI's `system`/`subtype:"status"` event with
 *   `status:"compacting"`.
 * - **Codex**: mapped from an `item/started` notification whose item
 *   `type:"contextCompaction"`.
 */
export interface AgentCompactionStartedEvent {
  type: "agent_compaction_started";
  /**
   * `"manual"` when ShipIt asked for the compaction (`/compact`), `"auto"` when
   * the CLI compacted on its own. Optional: Codex emits no manual/auto field, so
   * the adapter labels it by correlation (whether ShipIt sent the trigger) and
   * leaves it undefined when it can't tell.
   */
  trigger?: "manual" | "auto";
}

/**
 * docs/178 — a context compaction *finished*. This is transcript content (the
 * conversation history was replaced by a summary), so the orchestrator persists
 * it as an inline card via `emitChatCard`, not emit-only. Every detail field is
 * optional because Codex supplies none of them natively — the card degrades to a
 * bare "Context compacted" row when they're absent.
 *
 * - **Claude**: mapped from the CLI's `system`/`subtype:"compact_boundary"`
 *   event, whose `compact_metadata` carries `{trigger, pre_tokens, post_tokens,
 *   duration_ms}`.
 * - **Codex**: mapped from an `item/completed` notification whose item
 *   `type:"contextCompaction"`, with token figures pulled from the adjacent
 *   `thread/tokenUsage/updated` snapshot.
 */
export interface AgentCompactedEvent {
  type: "agent_compacted";
  /** See {@link AgentCompactionStartedEvent.trigger}. */
  trigger?: "manual" | "auto";
  /** Context-window occupancy (tokens) before compaction. */
  preTokens?: number;
  /** Context-window occupancy (tokens) after compaction. */
  postTokens?: number;
  /** How long the compaction took, in ms, when the backend reports it. */
  durationMs?: number;
}

/**
 * planning#114 / docs/193 — an agent backend is asking the user to approve a gated
 * action (a sensitive-file edit, an escalated command, …) that the backend
 * cannot auto-approve in ShipIt's headless model. This is the agent-agnostic
 * canonical shape: the worker's `PermissionBroker` broadcasts it (wrapped in an
 * `agent_event` SSE frame) the moment a request is registered, regardless of
 * which adapter produced it:
 *
 * - **Claude** routes its built-in sensitive-file gate to ShipIt's
 *   `--permission-prompt-tool` (the `shipit` bridge's permission tool,
 *   `mcp-tools/permission.ts`), which POSTs the request to the worker.
 * - **Codex** routes the app-server's blocking approval requests
 *   (`item/.../requestApproval`) through the same broker instead of
 *   auto-accepting them.
 *
 * The orchestrator renders + persists a `permission_request_card` from this
 * event; the user's approve/deny(+remember) answer flows back as a
 * `resolve_permission` WS message → `resolvePermission` → the broker, which
 * unblocks the held bridge/RPC call. The turn stays alive while the request is
 * pending (the CLI/app-server is blocked inside the tool call), so — unlike
 * AskUserQuestion — no interrupt/resume is needed.
 */
export interface AgentPermissionRequestEvent {
  type: "agent_permission_request";
  /** Stable id correlating the request, the rendered card, and the resolution. */
  requestId: string;
  /** The tool the agent tried to use (e.g. "Write", "Edit", "Bash", "apply_patch"). */
  toolName: string;
  /** The file path / resource the gate fired on, when one can be extracted from the tool input. */
  path?: string;
  /** One-line human description of what is being requested (shown on the card). */
  summary?: string;
  /**
   * The gated call in full — the raw `command`, or the pretty-printed tool
   * input — for the card's expandable disclosure. `summary` is clipped to one
   * ~100-char line, which for a `sed -i` cuts off the target path; this is what
   * lets the user actually read what they are approving. Bounded by
   * `PERMISSION_DETAILS_CHARS`, and omitted when it would only repeat `summary`.
   */
  details?: string;
  /** Which agent produced it (display only). */
  agentId?: AgentId;
}

/**
 * docs/193 — the terminal transition for a permission request, broadcast by the
 * broker when the user answers it (the only thing that settles a request), so
 * the orchestrator patches the persisted card to its terminal state
 * idempotently by `requestId`. There is no timeout/expiry transition — an
 * unanswered request simply stays pending; ShipIt imposes no deadline.
 */
export interface AgentPermissionResolvedEvent {
  type: "agent_permission_resolved";
  requestId: string;
  behavior: "allow" | "deny";
  /** True when the user asked to remember the decision for this path this session. */
  remembered?: boolean;
}

/**
 * docs/193 — the user's answer to a permission request. Travels from the client
 * (`resolve_permission` WS message) down to the worker's broker, which maps it
 * to each backend's native response: Claude's `--permission-prompt-tool`
 * envelope (`{behavior:"allow",updatedInput}` / `{behavior:"deny",message}`),
 * Codex's approval `{decision:"accept"|"reject"}`.
 */
export interface PermissionDecision {
  behavior: "allow" | "deny";
  /** Remember an `allow` for this path for the rest of the session (skip re-prompting). */
  remember?: boolean;
  /** Optional message surfaced to the agent on `deny`. */
  message?: string;
}

/** The fields a backend supplies to open a permission request via the broker. */
export interface PermissionRequestInput {
  /** The tool the agent tried to use (e.g. "Write", "Edit", "Bash", "apply_patch"). */
  toolName: string;
  /** The raw tool input, used to derive a resource path + summary when not given. */
  input?: Record<string, unknown>;
  /** Explicit resource path. When omitted, derived from `input`. */
  path?: string;
  /** Explicit one-line summary. When omitted, derived from toolName + path. */
  summary?: string;
  /** Which agent raised it (display only). */
  agentId?: AgentId;
  /**
   * The gated tool call's id. Used as the broker's idempotency key (docs/193,
   * Thread B): a retried/duplicated open for the same call re-attaches to the
   * one pending card instead of stacking another. Codex doesn't supply it (its
   * approval RPC is one-shot, not retried), so it stays optional.
   */
  toolUseId?: string;
}

/**
 * docs/193 — the worker injects this into adapters that surface gated actions
 * through a native blocking channel (Codex's app-server approval requests). The
 * adapter calls it to open a user-answerable approve/deny card and blocks on the
 * returned decision. Bound to the worker's `PermissionBroker.request`. Claude
 * doesn't use it (its requests arrive via the `--permission-prompt-tool` MCP
 * bridge, out of band of the adapter).
 */
export type PermissionRequester = (input: PermissionRequestInput) => Promise<PermissionDecision>;

/**
 * docs/235 — the agent backend's **complete current** background-task list
 * (not a delta). An agent can start work that outlives its turn — a
 * `Bash(run_in_background)` job, a scheduled wake-up — and finishing it makes
 * the backend start a fresh turn on its own, with no user message. The
 * orchestrator uses this as the *level* signal for `runner.agentBusy` so the
 * idle enforcer and the disk-tier ladder stop reclaiming a container that still
 * has work outstanding.
 *
 * Transient live state: emit-only, never persisted to chat history.
 *
 * - **Claude**: mapped from the CLI's `system`/`subtype:"background_tasks_changed"`.
 * - **Codex**: no equivalent today, so its adapter never emits this and the
 *   behavior degrades to the pre-docs/235 baseline.
 */
export interface AgentBackgroundTasksEvent {
  type: "agent_background_tasks";
  /** Empty array means drained — the authoritative current state, not a diff. */
  tasks: { id: string; type?: string; description?: string }[];
}

/**
 * docs/235 — the agent backend is starting a turn *on its own* because a
 * background task finished. The *edge* counterpart to
 * {@link AgentBackgroundTasksEvent}: the orchestrator marks the runner running
 * so the session reads as busy for the self-woken turn, which the ordinary
 * `agent_result` handler then clears.
 *
 * - **Claude**: mapped from the CLI's `system`/`subtype:"task_notification"`.
 * - **Codex**: no equivalent today.
 */
export interface AgentSelfWakeEvent {
  type: "agent_self_wake";
  taskId?: string;
  /**
   * What finished, in the backend's words. A background **shell** task supplies
   * a one-liner; a background **subagent** supplies its whole final report (the
   * CLI sets the task's terminal summary to the agent's joined final text). The
   * two are indistinguishable by content, so a consumer that wants the report
   * must key off {@link toolUseId} — never off the shape of this string.
   */
  summary?: string;
  /** e.g. `"completed"`. Terminal in every case: `completed | failed | stopped`. */
  status?: string;
  /**
   * The tool call that STARTED the finished task, when the backend correlates
   * one — for a backgrounded `Task`/`Agent` this is the very tool_use id whose
   * `tool_result` is sitting in the transcript as the CLI's launch
   * acknowledgement. It is what lets the orchestrator find that card and retire
   * it (docs/109 reqs 10–11); without it the completion is only a liveness edge.
   */
  toolUseId?: string;
  /** Subagent accounting, when the backend has it — the docs/109 req 5 chips. */
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}

export type AgentEvent =
  | AgentInitEvent
  | AgentAssistantEvent
  | AgentToolResultEvent
  | AgentResultEvent
  | AgentRateLimitsEvent
  | AgentSteerRejectedEvent
  | AgentUserReplayEvent
  | AgentCompactionStartedEvent
  | AgentCompactedEvent
  | AgentPermissionRequestEvent
  | AgentPermissionResolvedEvent
  | AgentBackgroundTasksEvent
  | AgentSelfWakeEvent;

/** Unified content blocks (text or tool use). */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

// ---- Run parameters ----

/**
 * docs/252 phase 3 — how this run is pointed at the selected model's service.
 *
 * Present only when there is something to shape: a **string-delivered**
 * credential, which is every custom service and the env-supplied first-party
 * routes. Absent for an account-delivered credential, where the CLI's own login
 * already binds it to its own vendor's endpoint — shaping that would break the
 * token exchange, not redirect it.
 *
 * **No secret travels in this payload.** `credentialSourceEnv` names a variable
 * the worker's own `process.env` already holds (delivered by the secrets push),
 * and `credentialTarget` says where the CLI reads it from; the adapter copies
 * one to the other at spawn. Storage name and spawn target are deliberately
 * different things — a service's storage name must never be a harness's own
 * variable, or the route works or fails depending on how the install happens to
 * be signed in (docs/252 Appendix A).
 */
export interface ServiceRouting {
  serviceId: string;
  /** Display name, for the provider block Codex wants and for logs. */
  serviceName: string;
  billingMode: BillingMode;
  /** The style resolved from the harness×model overlap — decides the wire format. */
  style: ApiStyle;
  /** Base URL for that style. Whether a `/v1` belongs in it is per-style; see the catalogue. */
  baseUrl: string;
  /** The variable in the worker's environment that holds the secret. */
  credentialSourceEnv: string;
  /** Where this harness reads the credential from. */
  credentialTarget: CredentialTarget;
}

export interface AgentRunParams {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd: string;
  permissionMode?: PermissionMode;
  /** Path to MCP config JSON file (e.g., for Playwright browser tools). */
  mcpConfigPath?: string;
  /**
   * User-configured MCP servers (docs/088). Configs are UNRESOLVED — `env`
   * and `headers` may still contain `$secret:` placeholders. The adapter's
   * `writeMcpConfig()` resolves them against its own `process.env`.
   * Raw secret values never travel in this payload.
   */
  mcpServers?: McpServerConfig[];
  /** Model alias or ID to use (e.g., "sonnet", "opus", "gpt-5.4"). */
  model?: string;
  /**
   * docs/252 phase 3 — base URL and credential for the selected model's service.
   * Absent ⇒ the CLI runs against its own vendor exactly as it did before this
   * feature. See {@link ServiceRouting}.
   */
  serviceRouting?: ServiceRouting;
  /**
   * Per-spawn HOME override for the CLI. Set by the sub-agent spawn path when a
   * SAME-harness spawn's credentials were provisioned into an isolated
   * per-spawn root (`provisionSubAgentSpawnHome`), so the spawned CLI reads
   * that root instead of the session subtree the live primary reads. Takes
   * precedence over the adapter's constructor-injected `resolveHome` (the
   * local-mode account scoping, docs/150 req 19) — a per-spawn answer is more
   * specific than a per-adapter one. Absent ⇒ unchanged resolution.
   */
  homeDir?: string;
  /**
   * Reasoning/effort level for this run, an agent-specific token from the
   * agent's `reasoning.options` (Claude: low…max via `--effort`; Codex:
   * none…xhigh via `model_reasoning_effort`). Undefined = pass no flag (the
   * CLI's native default). See docs/217-per-agent-reasoning.
   */
  reasoningEffort?: string;
  /**
   * Path to a Claude Code settings file (passed as `--settings`). The
   * orchestrator always points this at /etc/shipit/managed-settings.json for
   * the `claude` agent so the PreToolUse branch-block hook is active.
   * Claude-only; other adapters ignore it. See docs/130-block-branch-ops/plan.md.
   */
  settingsPath?: string;
  /**
   * When true, the Claude adapter sets SHIPIT_AUTO_CREATE_PR=1 in the CLI
   * environment, which the managed-settings.json Stop hook self-gates on to
   * enforce PR creation. Claude-only. See docs/129-stop-hook-pr-enforcement/plan.md.
   */
  autoCreatePr?: boolean;
  /**
   * docs/211 — when true this is a Sandbox session: the Claude adapter sets
   * SHIPIT_SANDBOX=1 in the CLI environment so the managed-settings.json
   * PreToolUse branch-block hook self-gates off (a sandbox owns its own branches
   * across cloned repos). Claude-only; other adapters ignore it.
   */
  sandbox?: boolean;
  /**
   * planning#267 — when true, the Claude adapter sets SHIPIT_GUARD_DESTRUCTIVE_GIT=1
   * in the CLI environment, which arms the managed-settings.json PreToolUse
   * hook's destructive-git rule (`git reset --hard`, `git checkout -f`,
   * force-push, starting a `git rebase`). Set only when the session is merged with a recorded
   * `mergedHeadSha` — the state `shipit branch reset-to-base` guards — so a
   * refused reset can't be worked around with hand-rolled git. Claude-only;
   * other adapters ignore it. See docs/130-block-branch-ops/plan.md.
   */
  guardDestructiveGit?: boolean;
  /**
   * When true, the Claude adapter spawns with --input-format stream-json
   * for live steering. Ignored by non-streaming adapters. (docs/140)
   */
  useStreaming?: boolean;
  /**
   * docs/178 — this run is a context-compaction request, not a normal prompt.
   * The orchestrator sets this when intercepting `/compact` and no resident
   * live process exists to call `compact()` on. Adapters honor it at spawn:
   * Claude treats the `/compact` prompt as the CLI slash command (no special
   * branch needed); Codex resumes the thread and issues `thread/compact/start`
   * instead of a normal `turn/start`. Ignored by adapters whose `/compact` rides
   * the normal prompt path.
   */
  compact?: boolean;
}

// ---- Per-agent MCP config writer (docs/155 hair 10) ----

/**
 * Resolved launch paths for the consolidated internal MCP bridge
 * (planning#130 / docs/199). The worker resolves this ONCE (`resolveBridge`,
 * preferring the precompiled bundle over tsx-on-source) and hands it to the
 * adapter, which writes a single `shipit` MCP server entry. The set of tools
 * that server exposes is selected per agent via the `SHIPIT_MCP_TOOLS` env, not
 * via separate bridges — Claude gets review/present/voice/bug/permission, Codex
 * gets review/present/voice/ask/bug. `tsxBin` is the spawn command (the `node`
 * binary for the compiled bundle, or `tsx` for `.ts` source); the field keeps
 * its historical name. The whole bridge is omitted when null (stripped-down test
 * image) so agent start never fails on it.
 */
export interface AgentMcpBridge {
  tsxBin: string;
  bridgePath: string;
}

/**
 * Per-spawn context the worker passes into `AgentProcess.writeMcpConfig()`.
 *
 * The adapter owns the CLI-specific wire format (Claude: `--mcp-config` JSON
 * file; Codex: `~/.codex/config.toml` block; Cursor: `mcp.json`). The worker
 * owns the cross-cutting context — the user-configured server list, the
 * review-bridge install paths, and the SSE channel that reports server-level
 * failures (e.g. missing secrets).
 */
export interface AgentMcpWriteContext {
  /**
   * User-configured MCP servers (docs/088). Strings still carry `$secret:` /
   * `$platform:` placeholders — the adapter substitutes them against
   * `process.env` via `resolveMcpServer()` before writing them out.
   */
  servers: McpServerConfig[];
  /**
   * The consolidated internal MCP bridge (planning#130 / docs/199), or `null` when
   * the worker can't locate the bridge files (stripped-down test image). Each
   * adapter writes a single `shipit` MCP server entry pointing at it and selects
   * the tools to expose via the `SHIPIT_MCP_TOOLS` env (Claude:
   * review/present/voice/bug/permission; Codex: review/present/voice/ask/bug).
   * When null the adapter omits the entry rather than failing agent start.
   */
  shipitBridge: AgentMcpBridge | null;
  /**
   * Surface a server-level failure to the worker so it can broadcast an
   * `mcp_server_status` SSE event. Called when an entry has to be dropped
   * (e.g. missing secret); never blocks agent start.
   */
  onServerFailed: (name: string, reason: string) => void;
}

/**
 * Result of `AgentProcess.writeMcpConfig()`. Every field is optional — an
 * adapter that doesn't need a CLI-side config file (because it writes to a
 * fixed location) returns `{}` and signals nothing back to the worker.
 */
export interface AgentMcpWriteResult {
  /**
   * Filesystem path to a Claude-style MCP JSON config; passed back into
   * `run()` via `params.mcpConfigPath`. Codex/Cursor leave this undefined
   * because their CLIs read from a fixed location (e.g. `config.toml`).
   */
  mcpConfigPath?: string;
  /**
   * Env vars the worker must set on the child process for this run. Codex
   * uses this to expose `$secret:`-resolved values via env indirection
   * without persisting the raw secret to `config.toml`.
   */
  runtimeEnv?: Record<string, string>;
  /**
   * Called by the worker when the agent's `done` event fires. Used by
   * Claude to unlink the per-turn JSON file.
   */
  cleanup?: () => void;
}

// ---- AgentProcess interface ----

export interface AgentProcessEvents {
  event: [AgentEvent];
  done: [exitCode: number];
  error: [Error];
  auth_required: [];
  log: [source: string, text: string];
  /**
   * Per-MCP-server runtime status (docs/088-mcp-integration). Emitted by
   * adapters whose underlying CLI surfaces real connection state — Claude
   * Code reports this in its init event's `mcp_servers` field. Adapters
   * that can't observe MCP liveness (e.g., Codex) simply never emit this.
   *
   * Each emission carries the full set of servers reported by the CLI in
   * that observation, so consumers can replace state per-server without
   * tracking which entries dropped out of a partial update.
   */
  mcp_status: [McpServerStatus[]];
  /**
   * planning#318 — this process no longer owns its runner's agent slot: a NEWER
   * spawn took the slot while this one had not reached a terminal event.
   *
   * Emitted by the RUNNER (not by the adapter) at the moment of displacement,
   * because that is the moment the displaced turn loses its ability to settle
   * itself. Its own `agent_done` / `agent_error` will arrive late and be
   * IGNORED by the docs/146 stale-spawn guard (`isStaleSpawnEvent`) — correct
   * for the SSE relay, since emitting them would run the displaced turn's
   * teardown against the live turn's slot, but it left the displaced turn's
   * settlement pending forever. A wake-turn stranded that way looked, to the
   * notify-on-merge retry supervisor, exactly like a delivery that never
   * happened, so it was re-delivered — a duplicate wake that also retired the
   * session's resident process.
   *
   * `executeAgentTurn` listens for this and SETTLES ONLY: no `setAgent(null)`,
   * no queue drain, no post-turn commit. The turn that displaced this one owns
   * the runner and the working tree; running this turn's teardown alongside it
   * is exactly the interference docs/146 exists to prevent.
   */
  superseded: [];
}

/**
 * The AgentProcess interface that all adapters implement.
 * Extends EventEmitter with typed events.
 */
export interface AgentProcess extends EventEmitter<AgentProcessEvents> {
  readonly agentId: AgentId;
  readonly capabilities: AgentCapabilities;

  /** Start the agent with the given parameters. */
  run(params: AgentRunParams): void;
  /** Write data to the running process's stdin. */
  writeStdin(data: string): void;
  /**
   * Inject a user message into the running turn (live steering) or send the
   * next message on a persistent streaming process. For non-streaming adapters
   * defaults to writeStdin. (docs/140)
   */
  sendUserMessage(text: string, opts?: { images?: ImageAttachment[] }): void;
  /**
   * True when this adapter owns a persistent streaming process (--input-format
   * stream-json for Claude). Post-turn lifecycle differs: done fires only on
   * process exit, not on turn end. (docs/140)
   */
  readonly isStreaming: boolean;
  /** Interrupt the running process (Ctrl+C equivalent). Falls back to kill. */
  interrupt(): void;
  /** Kill the running process. */
  kill(): void;
  /**
   * Change the resident process's permission mode mid-stream without a
   * restart. Optional — only the streaming Claude path supports it via the
   * CLI's `set_permission_mode` control_request (docs/138, docs/140). The
   * one-shot PTY path doesn't need it because each turn spawns fresh with
   * the requested mode; adapters without a control channel may omit it.
   */
  setPermissionMode?(mode: PermissionMode | undefined): void;
  /**
   * docs/178 — trigger a context compaction on the *resident* process. Optional,
   * gated by `capabilities.supportsCompaction`. Used by the `/compact`
   * interception when a live turn is in flight (a streaming Claude process or a
   * live Codex app-server with a thread): Claude injects the `/compact` slash
   * command via `sendUserMessage`; Codex sends the `thread/compact/start` RPC.
   * When no live process is resident the orchestrator spawns a fresh compaction
   * turn via `run({ compact: true })` instead, so adapters may treat this as a
   * best-effort no-op when there's nothing to talk to.
   *
   * `instructions` is the optional custom-compaction text from `/compact <args>`
   * — Claude appends it to the slash command (`/compact <args>`), which its CLI
   * honors; Codex's `thread/compact/start` RPC has no instruction parameter, so
   * it ignores them.
   */
  compact?(instructions?: string): void;
  /**
   * docs/193 — deliver the user's approve/deny answer for a pending permission
   * request to the backend. Optional: only meaningful for adapters whose run
   * surfaces gated actions through the worker's `PermissionBroker` (Claude via
   * `--permission-prompt-tool`, Codex via its app-server approval channel). The
   * orchestrator-side `ProxyAgentProcess` forwards it to the worker's
   * `/agent/permission/resolve` endpoint, where the broker unblocks the held
   * bridge/RPC call. Implemented by `ProxyAgentProcess` (the orchestrator-side
   * stand-in for the in-container agent); adapters without a permission channel
   * may omit it.
   */
  resolvePermission?(requestId: string, decision: PermissionDecision): void;
  /**
   * docs/193 — accept the worker's `PermissionBroker.request` so the adapter can
   * route its backend's native blocking approval requests through the shared
   * approve/deny card instead of auto-deciding. Injected by the worker right
   * after construction. Optional: only adapters with such a channel (Codex)
   * implement it; Claude's gate is bridged via `--permission-prompt-tool`.
   */
  setPermissionRequester?(requester: PermissionRequester): void;
  /**
   * planning#266 — stamp this turn's durable DELIVERY id onto the next spawn, so the
   * worker can report it back from `/agent/status` and an orchestrator that
   * restarted mid-turn can tell WHICH server-originated delivery the surviving
   * turn belongs to (see `turn-adoption.ts`).
   *
   * Optional and orchestrator↔worker only: `ProxyAgentProcess` forwards it in
   * the `/agent/start` body alongside `runToken`. In-process adapters omit it —
   * an in-process agent cannot outlive the orchestrator, so there is nothing to
   * re-identify.
   */
  setDeliveryId?(deliveryId: string): void;
  /**
   * Write whatever MCP configuration this CLI expects before the worker
   * calls `run()`. Each backend owns its own wire format (Claude:
   * `--mcp-config` JSON; Codex: `~/.codex/config.toml`; future Cursor:
   * `mcp.json`); the worker treats them uniformly via the result shape.
   *
   * (docs/155 — hair 10) Replaces the per-agent `if (agentId === "claude")`
   * / `if (agentId === "codex")` branches that used to live in
   * `session-worker.ts`.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult;
}

// ---- Worker agent start body ----

/**
 * Request body of the worker's `POST /agent/start` — the orchestrator→worker
 * call that launches a turn (`container-session-runner.ts` sends it,
 * `session/agent-controller.ts` handles it). Named and shared (rather than
 * inlined in the route generic) so the wire-contract guard
 * (`worker-wire-contract.test.ts`) checks the shape the handler actually uses:
 * since docs/113 Phase 1, old worker images outlive deploys, so changes to
 * this body must stay additive.
 */
export interface WorkerAgentStartBody {
  agentId: AgentId;
  params: AgentRunParams;
  runToken?: string;
  deliveryId?: string;
}

/**
 * Request body of the worker's `POST /agent/kill`. The kill is fire-and-forget
 * on the orchestrator side and can execute on the worker long after it was
 * issued — in production (2026-08-09, session 468191f5) a kill aimed at a
 * retired proxy resolved ~9 minutes late and SIGTERMed the *new* resident
 * streaming process mid-turn. `runToken` names the intended victim (the same
 * per-spawn token `/agent/start` records); the worker no-ops when the resident
 * spawn is not that victim. Optional so legacy callers (recovery paths, the
 * 409-desync clear) keep today's unconditional kill, and so an old worker that
 * ignores the body keeps working.
 */
export interface WorkerAgentKillBody {
  runToken?: string;
}

// ---- Worker agent status (docs/240) ----

/**
 * What the session worker's `GET /agent/status` reports about the agent slot
 * and any turn currently in flight on it.
 *
 * Shared because both layers depend on the shape: the worker
 * (`session/agent-controller.ts`) produces it, and the orchestrator
 * (`orchestrator/container-session-runner.ts`) consumes it before its first SSE
 * connect to decide whether to skip a completed turn's replay or ADOPT a turn
 * that outlived an orchestrator restart.
 *
 * Every field beyond `running` / `latestSseSeq` is optional on the wire: a
 * container started by an older orchestrator build runs an older worker, and the
 * consumer treats a missing `turnActive` as "unknown" and keeps the pre-docs/240
 * conservative behavior.
 */
export interface WorkerAgentStatus {
  /** A backend process occupies the single agent slot (may be idle-resident). */
  running: boolean;
  /** Highest SSE seq broadcast so far. */
  latestSseSeq: number;
  /** Oldest SSE seq still replayable from the ring buffer (0 when empty). */
  oldestSseSeq?: number;
  /**
   * A turn is genuinely mid-flight: started via `/agent/start` or
   * `/agent/message` and not yet ended by `agent_result` / process exit.
   * Distinct from `running`, which stays true for a resident streaming process
   * sitting idle between turns.
   */
  turnActive?: boolean;
  /** SSE seq at the instant the in-flight turn started (0 when none). */
  turnStartSseSeq?: number;
  /** The spawning proxy's run token, so a re-created proxy can keep the epoch. */
  runToken?: string;
  /**
   * planning#266 — the durable DELIVERY id of the turn in flight, when it was
   * dispatched on behalf of a server-side delivery (a notify-on-merge wake,
   * either `kind`). Ground truth for "is this delivery still live?": a
   * restarted orchestrator reads it here, rebinds the delivery's completion
   * settlement onto the adopted turn, and the watch's reconcile therefore
   * redispatches only when NO live worker reports the delivery. Absent for an
   * ordinary user turn, and on a legacy worker.
   */
  deliveryId?: string;
  /** Which backend occupies the slot. */
  agentId?: AgentId;
  /** The spawn was started in live-steering (streaming) mode. */
  streaming?: boolean;
  /**
   * docs/242 — outstanding background tasks on the resident process, from the
   * last {@link AgentBackgroundTasksEvent} (the docs/235 *level* signal). 0 when
   * drained or when no process is resident.
   *
   * The orchestrator holds the same fact on the runner
   * (`runner.backgroundTaskCount`), but that state is in-memory and dies with the
   * process — so a restarted orchestrator's boot sweep has no way to see pending
   * work unless the WORKER reports it. Without this field the sweep reads a
   * session waiting on a backgrounded review as idle and destroys the container
   * the task is running in.
   */
  backgroundTaskCount?: number;
  /**
   * docs/242 — a turn the CLI started *on its own* is in flight (the docs/235
   * *edge* signal, from {@link AgentSelfWakeEvent}). Set when the backend
   * self-wakes; cleared by the same `agent_result` / process exit that clears
   * {@link turnActive}.
   *
   * Deliberately NOT folded into `turnActive`: that field means "the
   * orchestrator started a turn and can replay it from `turnStartSseSeq`", and
   * the adoption path keys its cursor off that pairing. This one only says the
   * worker is busy — enough for a reclaim decision, and it claims nothing about
   * replayability.
   */
  selfWakeActive?: boolean;
}
