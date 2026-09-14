import {
  REPOSITORY_ADDRESS,
  configuredOnly,
  defineSetting,
  derived,
  plain,
  repositoryItemAddress,
  userName,
} from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { userNameProjection } from "./projection.js";
import { REPO_COLOR_COUNT } from "../repo-colors.js";
import { bool, collection, numeric, text } from "./value-types.js";

/** The store hands back a list of names; the route body is keyed by them. */
function secretNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((name): name is string => typeof name === "string");
  return Object.keys(raw ?? {});
}

/**
 * The per-repository **Project Settings** dialog, which req 5 names alongside
 * the global one (docs/299-agent-settings-access, requirements.md resolved
 * 2026-09-13). It holds two of the things agent-facing docs still tell the agent
 * to ask the user for by hand: the agent-merge permission
 * (`shipit-docs/github.md:263`) and the secrets a repository's services need.
 *
 * **Every declaration here is addressed by repository, and that repository is
 * resolved from the session's own binding — never from anything the agent
 * supplies.** An unbound session reads these as unavailable; it does not read
 * someone else's repository.
 */

export const PROJECT_SETTINGS = {
  "project.allowAgentMerge": defineSetting({
    key: "project.allowAgentMerge",
    tab: "project-deployments",
    scope: "project",
    address: REPOSITORY_ADDRESS,
    label: "Allow agents to merge their own pull requests",
    description:
      "An agent may merge only the pull request its own session opened, and only when every check "
      + "has passed. Branch protection and required reviews are still enforced by GitHub. Off for "
      + "every repository until you turn it on.",
    type: bool({ default: false }),
    // The route is deliberately browser-only, so an agent cannot grant itself
    // the permission; a proposal the user clicks is the only path it has.
    store: { kind: "bespoke", ownedBy: "the repositories store (PATCH /api/repos/:url `allowAgentMerge`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "project.secrets": defineSetting({
    key: "project.secrets",
    tab: "project-secrets",
    scope: "project",
    address: REPOSITORY_ADDRESS,
    label: "Secrets",
    description:
      "Values this repository's services need at runtime — API keys, database URLs. ShipIt reports "
      + "which names are set and never a value; the browser never receives one either.",
    type: collection<string>({ operations: ["set", "remove"], patchableFields: [] }),
    store: { kind: "bespoke", ownedBy: "the repository secrets store (PUT /api/secrets)" },
    // Names only (plan.md → Scope inventory): the name says what is missing,
    // which is the whole of what the agent needs to ask the user for. The
    // projection's work is dropping the value column, which no field-name rule
    // would do for a record the user keys.
    //
    // `PUT /api/secrets` takes any string as a key, so the names go through the
    // same shape gate the allowlist entries do — this is the collection an
    // item's ADDRESS is projected through, so a name emitted here is a name the
    // agent repeats back in every output path.
    emits: derived(
      "the secret names that are set, never a value; a name not shaped like one is dropped, since "
      + "it can carry a credential and cannot be an environment variable anyway",
      (raw) => secretNames(raw).map(userNameProjection).filter((name) => name !== null),
      {
        userText: "The names are the user's own. Naming the missing secret is the whole of what the "
          + "agent has to tell them, so the names are emitted deliberately and the values never are.",
      },
    ),
    propose: { kind: "no", reason: "secret" },
  }),

  "project.secrets[].name": defineSetting({
    key: "project.secrets[].name",
    tab: "project-secrets",
    scope: "project",
    address: repositoryItemAddress("a secret name in the session's repository"),
    label: "Secret name",
    description:
      "What one secret is called — the environment variable a service reads. A repository's "
      + "docker-compose.yml and its plugins declare the ones they need; the user may add others.",
    type: text({ maxLength: 200, noun: "Secret name", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "the repository secrets store (PUT /api/secrets)" },
    emits: userName(
      "The name the user gave their own secret. It is what the agent must be able to name when it "
      + "asks for one to be set, and it is already shown in the dialog and to every service.",
    ),
    // A name with no value does nothing, and only the user can supply the value.
    propose: { kind: "no", reason: "secret" },
  }),

  "project.secrets[].value": defineSetting({
    key: "project.secrets[].value",
    tab: "project-secrets",
    scope: "project",
    address: repositoryItemAddress("a secret name in the session's repository"),
    label: "Secret value",
    description:
      "What one named secret is set to. Only the user can supply it — ShipIt reports whether the "
      + "name has a value and nothing more.",
    type: text({ maxLength: 10_000, noun: "Secret value" }),
    store: { kind: "bespoke", ownedBy: "the repository secrets store (PUT /api/secrets)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "project.colorIndex": defineSetting({
    key: "project.colorIndex",
    tab: "project-appearance",
    scope: "project",
    address: REPOSITORY_ADDRESS,
    label: "Sidebar color",
    description:
      "The colored edge marking this repository's group in the session sidebar. Each repository "
      + "gets a different one automatically; this is the override.",
    type: numeric({ default: 0, min: 0, max: REPO_COLOR_COUNT - 1, integer: true }),
    store: { kind: "bespoke", ownedBy: "the repositories store (PATCH /api/repos/:url `colorIndex`)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
