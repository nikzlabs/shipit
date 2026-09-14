import { defineSetting, derived, itemAddress, plain, userText } from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
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
    emits: derived("the role names", (raw) =>
      Array.isArray(raw)
        ? raw
            .map((role) => (typeof role === "string" ? role : (role as { name?: unknown })?.name))
            .filter((name): name is string => typeof name === "string")
        : []),
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
    emits: userText("The name the user gave their own role, and the name the agent addresses it by."),
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
    type: text({ maxLength: 64, noun: "Reasoning level" }),
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
    type: text({ maxLength: 2_000, noun: "Role description" }),
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
    type: text({ maxLength: 50_000, noun: "Standing instructions" }),
    store: { kind: "bespoke", ownedBy: "credential-store roles (PUT /api/settings `roles`)" },
    emits: userText("The user's own instructions for their role, shown because they are theirs."),
    propose: { kind: "yes" },
  }),

  "reviewers": defineSetting({
    key: "reviewers",
    tab: "roles",
    scope: "global",
    label: "Reviewer candidates",
    description:
      "The two slots ShipIt picks a reviewer from. A slot is either pinned to a model or left on "
      + "automatic; the harness is derived per review rather than pinned.",
    type: collection<string>({ operations: ["pin", "clear"], patchableFields: ["model", "reasoningEffort"] }),
    store: { kind: "bespoke", ownedBy: "credential-store reviewer slots (PUT /api/settings `reviewers`)" },
    emits: derived("each slot and whether it is pinned or automatic", (raw) =>
      Array.isArray(raw)
        ? raw.map((entry) => {
            const row = entry as { slot?: unknown; source?: unknown };
            return {
              slot: typeof row?.slot === "string" ? row.slot : null,
              source: typeof row?.source === "string" ? row.source : null,
            };
          })
        : []),
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
