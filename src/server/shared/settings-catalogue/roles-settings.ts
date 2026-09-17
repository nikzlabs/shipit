import { defineSetting, derived, itemAddress, plain, userName, userText } from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import type { AgentRole, RoleAutoParams, RolePinnedParams } from "../types/agent-types.js";
import { userNamesProjection } from "./projection.js";
import { collection, modelSelection, text } from "./value-types.js";

/**
 * The **Roles** tab (docs/299-agent-settings-access, plan.md → Scope
 * inventory). A role is an item, so every field of it is declared with an item
 * address; the collection itself is declared too, for the operations that add,
 * rename and remove one.
 *
 * **The mutation unit is not the field.** Picking a role's model rewrites
 * service, billing mode and model id together and re-derives harness and effort
 * (`Settings/roles/RoleEditor.tsx:93`), so `roles.model` is the tuple. The
 * field-level split here is for discovery — what exists, what it says, what may
 * be proposed — and plan.md → The unit of a change is the declared operation is
 * where the two meet.
 */

const ROLE_ADDRESS = itemAddress("a role name");
const SLOT_ADDRESS = itemAddress("a reviewer slot, first or second");

export const ROLES_SETTINGS = {
  "roles": defineSetting({
    key: "roles",
    tab: "roles",
    component: "roles",
    scope: "global",
    label: "Roles",
    description:
      "Named targets the agent can run work on — a reviewer, a deep-dive researcher. Each one "
      + "carries the harness, model and effort level it runs at, so starting one costs a name and "
      + "nothing else.",
    type: collection<string>({
      operations: ["create", "rename", "remove", "update"],
      patchableFields: ["description", "prompt", "harness", "model", "reasoningEffort"],
    }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    // A role name is only checked for being non-blank and short enough
    // (`services/role-settings.ts:200`), so it goes through the same shape gate
    // the allowlist entries do. This is the collection an item's ADDRESS is
    // projected through, so a name emitted here is one the agent repeats back.
    emits: derived(
      "the role names; a name not shaped like one is dropped, since it can carry a credential",
      userNamesProjection,
      {
        userText: "The names are the user's own, and the names the agent addresses a role by — "
          + "`--role <name>` is unusable without them.",
      },
    ),
    propose: { kind: "yes" },
  }),

  "roles[].name": defineSetting({
    key: "roles[].name",
    tab: "roles",
    scope: "global",
    address: ROLE_ADDRESS,
    label: "Name",
    description:
      "What the role is called, and what --role takes. The reviewer role is reserved: ShipIt picks "
      + "what it runs on per review, so its name cannot be changed.",
    type: text({ maxLength: 64, noun: "Role name", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: userName("The name the user gave their own role, and the name the agent addresses it by."),
    propose: { kind: "yes" },
  }),

  "roles[].model": defineSetting({
    key: "roles[].model",
    tab: "roles",
    scope: "global",
    address: ROLE_ADDRESS,
    label: "Runs on",
    description:
      "The model this role runs on: a service, a billing mode and a model id, written together. "
      + "Changing it re-derives the harness and the effort level, because a level only exists on a "
      + "harness that honours it for that model.",
    type: modelSelection(),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "roles[].harness": defineSetting({
    key: "roles[].harness",
    tab: "roles",
    scope: "global",
    address: ROLE_ADDRESS,
    label: "Harness",
    description:
      "Which agent CLI runs this role's model. Only the harnesses this install has, and only "
      + "those that can run the role's model, are eligible.",
    type: text({ maxLength: 64, noun: "Harness" }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "roles[].reasoningEffort": defineSetting({
    key: "roles[].reasoningEffort",
    tab: "roles",
    scope: "global",
    address: ROLE_ADDRESS,
    label: "Reasoning level",
    description:
      "How hard the model thinks on this role's work. The levels come from the harness the role "
      + "names, for the model it names — unset means the harness's own default.",
    // `pinned()` stores no level for an empty string, so empty and "not set"
    // are one value here — and the declaration is where that is said, so a card
    // clearing the level shows the "not set" the role will hold rather than the
    // `""` it was asked for (docs/299-agent-settings-access req 4).
    type: text({ maxLength: 64, noun: "Reasoning level", emptyIsUnset: true }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "roles[].description": defineSetting({
    key: "roles[].description",
    tab: "roles",
    scope: "global",
    address: ROLE_ADDRESS,
    label: "Description",
    description:
      "What this role is for. The agent reads it to pick this role and to pitch the prompts it "
      + "sends here.",
    type: text({ maxLength: 2_000, noun: "Role description", trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: userText("The user's own words about their role, and the words the agent is meant to read."),
    propose: { kind: "yes" },
  }),

  "roles[].prompt": defineSetting({
    key: "roles[].prompt",
    tab: "roles",
    scope: "global",
    address: ROLE_ADDRESS,
    label: "Standing instructions",
    description: "Added to whatever task the role is given.",
    type: text({ maxLength: 50_000, noun: "Standing instructions", trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: userText("The user's own instructions for their role, shown because they are theirs."),
    propose: { kind: "yes" },
  }),

  "reviewers": defineSetting({
    key: "reviewers",
    tab: "roles",
    component: "roles",
    scope: "global",
    label: "Reviewer candidates",
    description:
      "The two slots ShipIt picks a reviewer from. A slot is either pinned to a model or left on "
      + "automatic; the harness is derived per review rather than pinned.",
    type: collection<string>({ operations: ["pin", "clear"], patchableFields: ["model", "reasoningEffort"] }),
    store: { kind: "bespoke", ownedBy: "credential-store reviewer slots (PUT /api/settings `reviewers`)" },
    emits: derived(
      "each slot and whether it is pinned or automatic",
      (raw) =>
        Array.isArray(raw)
          ? raw.map((entry) => {
              const row = entry as { slot?: unknown; source?: unknown };
              return {
                slot: typeof row?.slot === "string" ? row.slot : null,
                source: typeof row?.source === "string" ? row.source : null,
              };
            })
          : [],
      { shipItComputed: "\"first\" and \"second\" are ShipIt's own names for the two slots, and pinned/automatic is ShipIt's own reading of them. The user names nothing here." },
    ),
    propose: { kind: "yes" },
  }),

  "reviewers[].model": defineSetting({
    key: "reviewers[].model",
    tab: "roles",
    scope: "global",
    address: SLOT_ADDRESS,
    label: "Reviewer candidate",
    description:
      "One of the two models ShipIt picks a reviewer from. Unset leaves the slot on automatic, "
      + "where ShipIt chooses per review — whichever configured candidate is furthest from the "
      + "model that wrote the work.",
    type: modelSelection(),
    store: { kind: "bespoke", ownedBy: "credential-store reviewer slots (PUT /api/settings `reviewers`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "reviewers[].reasoningEffort": defineSetting({
    key: "reviewers[].reasoningEffort",
    tab: "roles",
    scope: "global",
    address: SLOT_ADDRESS,
    label: "Reviewer reasoning level",
    description:
      "How hard this reviewer candidate thinks. The harness is derived per review rather than "
      + "pinned, so the levels are those its resolved harness honours for the pinned model.",
    type: text({ maxLength: 64, noun: "Reviewer reasoning level" }),
    store: { kind: "bespoke", ownedBy: "credential-store reviewer slots (PUT /api/settings `reviewers`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;

export type RolesSettingKey = keyof typeof ROLES_SETTINGS;

/**
 * The one declaration a stored role field may name: its own.
 *
 * Naming *any* declaration is the pass the DOM walk already gives — a control
 * bound to something that exists — and it is the loophole this map is here to
 * close. Deriving the key from the field name means the only way to account for
 * a new field is to declare it under that name, or to say in prose why it is one
 * of the two other things below.
 */
type DeclarationForRoleField<F extends string> =
  `roles[].${F}` extends RolesSettingKey ? `roles[].${F}` : never;

/**
 * The only two declarations a stored field may be *part of* — an enumerated
 * allowlist, not "any key in the family".
 *
 * Admitting every `RolesSettingKey` here left the loophole open one step further
 * along: a new field could name `{ partOf: "roles[].description" }` and pass, and
 * a control bound to that same declaration passes the DOM walk, so the field
 * would ship undeclared exactly as before. Both entries are aggregates rather
 * than fields — `roles[].model` is a three-part tuple, `roles[].harness` is the
 * stored `harnessId` under the name the user picks — so widening the list is a
 * deliberate edit with a claim attached, which is what `reason` records.
 */
type RoleAggregateSettingKey = "roles[].model" | "roles[].harness";

/**
 * A field the declared **mutation unit** covers rather than declaring under its
 * own name. Picking a role's model rewrites service, billing mode and model id
 * together (`Settings/roles/RoleEditor.tsx`), so those three are one declared
 * tuple and not three settings — plan.md → The unit of a change is the declared
 * operation.
 */
interface PartOfRoleSetting {
  readonly partOf: RoleAggregateSettingKey;
  readonly reason: string;
}

/**
 * A field whose own fields are declared one map deeper. Named as a literal
 * rather than a string: `{ fieldsDeclaredIn: "NO_SUCH_MAP" }` would otherwise
 * account for a field by pointing at nothing.
 */
interface NestedRoleFields {
  readonly fieldsDeclaredIn: "ROLE_PARAMS_FIELD_SETTINGS";
}

/** Why a stored field is not a setting at all — the same prose claim `exclusions.ts` makes. */
interface NotARoleSetting {
  readonly notASetting: string;
}

/**
 * What a stored field may be, OTHER than the declaration named for it. The bare
 * `RolesSettingKey` is deliberately absent: admitting it would let a field name
 * any declaration in the family, which is the "mapped to something that exists"
 * pass this map exists to refuse.
 */
export type RoleFieldMapping = PartOfRoleSetting | NestedRoleFields | NotARoleSetting;

/**
 * **Every field of a stored role, mapped to the declaration that describes it**
 * (docs/299-agent-settings-access req 7: no way to ship a setting the agent
 * cannot see).
 *
 * The same guard `MCP_SERVER_FIELD_SETTINGS` makes over an MCP server: keyed by
 * `keyof AgentRole`, a field added to `agent-types.ts` is a compile error here
 * until it is declared or explained.
 */
export const ROLE_FIELD_SETTINGS: {
  [F in keyof Required<AgentRole>]: DeclarationForRoleField<F & string> | RoleFieldMapping;
} = {
  name: "roles[].name",
  description: "roles[].description",
  prompt: "roles[].prompt",
  params: { fieldsDeclaredIn: "ROLE_PARAMS_FIELD_SETTINGS" },
};

/**
 * Every field of a role's stored parameters, mapped the same way. `params` is
 * where the harness, the model tuple and the effort level actually live, so a
 * map that stopped at `keyof AgentRole` would cover the two prose fields and
 * miss everything the agent proposes.
 */
export const ROLE_PARAMS_FIELD_SETTINGS: {
  [F in keyof Required<RolePinnedParams> | keyof RoleAutoParams]:
    DeclarationForRoleField<F & string> | RoleFieldMapping;
} = {
  kind: {
    notASetting: "The discriminant. `auto` exists only for the reserved reviewer, whose own "
      + "parameters render no control at all (plan.md → Not everything in a dialog is a setting); "
      + "every other role is pinned, so nobody chooses this.",
  },
  harnessId: {
    partOf: "roles[].harness",
    reason: "Declared under what the user picks rather than what is stored.",
  },
  serviceId: {
    partOf: "roles[].model",
    reason: "One third of the declared model tuple; picking a model rewrites all three together, "
      + "so a field-by-field proposal would require invalid intermediate states.",
  },
  billingMode: {
    partOf: "roles[].model",
    reason: "One third of the declared model tuple, written with the service and the model id.",
  },
  modelId: {
    partOf: "roles[].model",
    reason: "One third of the declared model tuple, written with the service and the billing mode.",
  },
  reasoningEffort: "roles[].reasoningEffort",
};
