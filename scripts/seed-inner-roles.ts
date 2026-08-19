/**
 * Seed the dogfood inner ShipIt with a few agent roles (docs/131, docs/264).
 *
 * ## Why this exists — an install with no roles hides every role surface
 *
 * The inner instance is where role-related UI is checked by hand, and it booted
 * with **zero** roles. That is not a neutral starting point: the composer's role
 * control, Settings → Roles' populated list, and a role's disabled state cannot
 * be looked at on an install that has nothing to list. `reviewer` is always
 * present (docs/264-agent-roles req 2) but it is reserved, its params are
 * resolved rather than pinned, and it is the one role that exercises none of
 * what a user-created role does.
 *
 * ## The params are RESOLVED, never hardcoded
 *
 * A hardcoded `(harness, service, billing mode, model)` tuple would produce
 * roles that are stranded on any install whose secrets differ from the author's
 * — the opposite of useful, and a worse starting point than no roles at all. So
 * this reads {@link BootstrapSettings.agents} — the same credential-filtered
 * join the Settings role editor renders from — and picks a real harness, a real
 * model and a real reasoning level out of it. A recipe says *what kind* of role
 * it wants ("the primary harness, at its highest level"); this install says what
 * that means today.
 *
 * ## One deliberately-unavailable role, when this install can express one
 *
 * {@link planUnavailableRole} seeds a role whose tuple is catalogue-valid but
 * whose service has no credential here, so it renders "shown, disabled, with its
 * reason" (`disconnected`) — the state the other three roles cannot show. It is
 * derived, not written down: an install that holds every credential simply gets
 * no such role rather than a hardcoded one that silently starts working.
 *
 * `disconnected` is also the only unavailable state that is *seedable*. A
 * `stranded` role names something the catalogue does not have, and the save
 * validator refuses exactly that (docs/264-agent-roles req 6); `quota_exhausted`
 * is a routing state nothing can write.
 *
 * ## Contract, deliberately the same as the other two seeders' (docs/131)
 *
 *   - req 3: `DOGFOOD_SEED=0` disables it, and `DOGFOOD_SEED_ROLES=0` disables
 *     just this half — the per-step switch `DOGFOOD_SEED_CREDENTIALS=0` is for
 *     the credential half.
 *   - req 4: a role whose **name** is already present is left completely alone.
 *     The name is the identity, so a role the developer edited in the inner UI
 *     survives every restart and is never reconciled back to the seeded shape.
 *   - req 5: every failure is logged and the remaining roles still get their
 *     turn — hence one `PUT` per role rather than one batched write, since
 *     `applyRoleWrites` validates the whole batch before writing any of it and
 *     one bad entry would take the good ones down with it. Always exits 0.
 *   - req 6: it never blocks the inner UI; compose backgrounds it.
 *
 * **`reviewer` is never written** (docs/264-agent-roles req 2). It exists on
 * every install, its params resolve per run, and the settings surface refuses to
 * store pinned params under that name anyway — so naming it here could only
 * produce a 400.
 *
 * Run with `npx tsx` (not bare `node`) — like its credential-seeding sibling it
 * imports the catalogue, which is TypeScript.
 */

import type { AgentId } from "../src/server/shared/types.js";
import type { RolePinnedParams } from "../src/server/shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../src/server/shared/types/agent-types.js";
import { catalogueEntriesForHarness } from "../src/server/shared/catalogue/index.js";

/** Inner orchestrator. Compose runs it on 4000; Vite proxies /api to it. */
const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

/** Bounded wait — the orch boots behind an `agent.install` gate. */
const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

const log = (msg: string): void => { console.log(msg); };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- What we read out of the install ---------------------------------------

/** One harness as `GET /api/bootstrap` reports it — the fields a role needs. */
export interface BootstrapAgent {
  id: string;
  name: string;
  installed: boolean;
  eligibleModels?: { serviceId: string; billingMode: "sub" | "key"; modelId: string; label: string }[];
  reasoning?: { options: { value: string; label: string }[] };
}

/** The slice of `settings` this script reads. */
export interface BootstrapSettings {
  agents?: BootstrapAgent[];
  roles?: { name: string }[];
}

// ---- Recipes: what kind of role, not which tuple ----------------------------

/**
 * Which end of a harness's declared reasoning levels a recipe wants.
 *
 * `"default"` means **name no level at all**, which docs/264-agent-roles req 1
 * settled as a complete role: it runs at whatever its harness runs at when
 * ShipIt passes no flag. Seeding one is deliberate — it is the encoding the
 * editor and the composer both show as "Default", and a set where every role
 * named a level would never exercise it.
 */
type LevelChoice = "highest" | "lowest" | "default";

/**
 * A role to seed, described by what it should *be* rather than what it should
 * run. {@link resolveRecipe} turns one into a tuple against this install.
 */
export interface RoleRecipe {
  name: string;
  /**
   * docs/264-agent-roles req 9, and req 19 is why these are written the way they
   * are: the agent reads a role's description to decide which role an unnamed
   * request means AND how much its prompt has to spell out. A description that
   * only said "the fast one" would be a note to self.
   */
  description: string;
  /** Req 8 — standing instructions. Absent on purpose for some, since a role without them is complete. */
  prompt?: string;
  /**
   * `"secondary"` wants a *different* harness from the primary one, and is
   * skipped where this install runs only one. Harness variety is a thing the
   * role surfaces show (a role names its harness, req 6) and one harness cannot
   * demonstrate.
   */
  harness: "primary" | "secondary";
  level: LevelChoice;
}

/**
 * The set. Small on purpose — enough to exercise the surfaces, few enough that
 * the inner Settings → Roles list still reads as a list someone curated.
 *
 * Between them they cover: two runnable roles at different reasoning levels, one
 * carrying both a description and standing instructions, one carrying a
 * description only, and one at `Default`.
 */
export const RECIPES: readonly RoleRecipe[] = [
  {
    name: "deep-dive",
    description:
      "Slow and thorough. Give it an open brief and room to explore — it reads widely, follows "
      + "leads of its own and is worth waiting for. Do not hand it a checklist that pre-decides "
      + "the work.",
    prompt:
      "You are working on a hard problem that rewards patience. Read the surrounding code before "
      + "you conclude anything, verify a guarantee at its source rather than trusting a doc that "
      + "describes it, and say plainly what you could not establish.",
    harness: "primary",
    level: "highest",
  },
  {
    name: "quick-look",
    // Deliberately NOT described as "cheap": what this recipe varies is the
    // reasoning level, and the model it lands on is whatever the harness's
    // eligible list offers first — often the same one `deep-dive` uses. A
    // description promising a small model would be a description the agent
    // reads (req 19) and acts on, and it would be false.
    description:
      "A short leash: the same harness at its lowest reasoning level, for one narrow "
      + "well-specified question. Give it an explicit, ordered brief and a single deliverable — "
      + "it is not the role to hand an open-ended investigation to.",
    harness: "primary",
    level: "lowest",
  },
  {
    name: "second-opinion",
    description:
      "A different harness from the one that usually does the work here, at its own default "
      + "reasoning level. For when the useful thing is a reader who does not share the "
      + "implementer's blind spots.",
    prompt:
      "Read the work you are given and say what is wrong with it. Do not edit any files — this "
      + "workspace belongs to the session that called you.",
    harness: "secondary",
    level: "default",
  },
];

/** The deliberately-unavailable role's name, so the test and the docs agree with the code. */
export const UNAVAILABLE_ROLE_NAME = "needs-a-credential";

// ---- Planning ---------------------------------------------------------------

/** One role, resolved against this install and ready to write. */
export interface PlannedRole {
  name: string;
  description: string;
  prompt?: string;
  params: RolePinnedParams;
}

/** The outcome of one role, for the caller's log and the tests' assertions. */
export interface SeedRoleResult {
  name: string;
  outcome: "seeded" | "skipped" | "failed";
  detail?: string;
}

/**
 * The harnesses a role may name here, in bootstrap order.
 *
 * `installed` **and** at least one eligible model: a harness the deployment did
 * not install cannot carry a role at all, and one with no eligible model would
 * produce a role that is `disconnected` from birth — which is the
 * deliberately-unavailable role's job, not the runnable ones'.
 */
export function runnableHarnesses(agents: readonly BootstrapAgent[]): BootstrapAgent[] {
  return agents.filter((a) => a.installed && (a.eligibleModels?.length ?? 0) > 0);
}

/** The level a recipe means on this harness, or `undefined` for Default. */
function levelFor(harness: BootstrapAgent, choice: LevelChoice): string | undefined {
  if (choice === "default") return undefined;
  const options = harness.reasoning?.options ?? [];
  // A harness that declares no levels takes a role with no level (docs/274
  // req 8) — the same encoding `"default"` asks for, reached from the other end.
  if (options.length === 0) return undefined;
  const option = choice === "highest" ? options[options.length - 1] : options[0];
  return option?.value;
}

/**
 * Turn one recipe into a tuple, or `undefined` where this install cannot express
 * it (a `"secondary"` recipe on a single-harness install).
 *
 * The model is the harness's **first** eligible one, which is catalogue order —
 * deterministic, and the same model the editor's picker opens on.
 */
export function resolveRecipe(
  recipe: RoleRecipe,
  harnesses: readonly BootstrapAgent[],
): PlannedRole | undefined {
  const harness = recipe.harness === "primary" ? harnesses[0] : harnesses[1];
  if (!harness) return undefined;
  const model = harness.eligibleModels?.[0];
  if (!model) return undefined;
  const reasoningEffort = levelFor(harness, recipe.level);
  return {
    name: recipe.name,
    description: recipe.description,
    ...(recipe.prompt ? { prompt: recipe.prompt } : {}),
    params: {
      kind: "pinned",
      harnessId: harness.id as AgentId,
      serviceId: model.serviceId,
      billingMode: model.billingMode,
      modelId: model.modelId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    },
  };
}

/**
 * A role that is catalogue-valid and has no credential here, so it renders
 * `disconnected` — or `undefined` where this install holds a credential for
 * everything its harnesses can speak to.
 *
 * Derived rather than written down, and that is the whole point: a hardcoded
 * "unavailable" tuple is only unavailable on the install it was written on. Here
 * the first catalogue entry that is NOT in the harness's eligible set is by
 * construction a `(service, mode)` this install cannot authenticate, whatever
 * its secrets happen to be.
 *
 * The harness itself is a runnable one, deliberately: that isolates the reason
 * to the missing credential, so the inner UI shows `disconnected` ("reconnect
 * the service") rather than a role that is also broken in some other way.
 */
export function planUnavailableRole(
  harnesses: readonly BootstrapAgent[],
): PlannedRole | undefined {
  for (const harness of harnesses) {
    const eligible = new Set(
      (harness.eligibleModels ?? []).map((m) => `${m.serviceId}:${m.billingMode}:${m.modelId}`),
    );
    for (const entry of catalogueEntriesForHarness(harness.id as AgentId)) {
      const { serviceId, billingMode, modelId } = entry.selection;
      if (eligible.has(`${serviceId}:${billingMode}:${modelId}`)) continue;
      return {
        name: UNAVAILABLE_ROLE_NAME,
        description:
          `Seeded deliberately unavailable, so the disabled state is visible: it names `
          + `${entry.model.label} on ${entry.service.name} `
          + `(${billingMode === "sub" ? "subscription" : "API key"}), which this install holds `
          + `no credential for. Connect that service and it starts working.`,
        params: {
          kind: "pinned",
          harnessId: harness.id as AgentId,
          serviceId,
          billingMode,
          modelId,
        },
      };
    }
  }
  return undefined;
}

/**
 * Every role this run would write: the recipes this install can express, plus
 * the unavailable one where there is one, minus every name that already exists.
 *
 * req 4 — the name is the idempotency key, and a present name is left
 * *completely* alone rather than reconciled: the developer may have re-pointed
 * `deep-dive` at a different model in the inner UI, and a seeder that corrected
 * that on every restart would be a worse tool than one that seeds nothing.
 */
export function planRoles(settings: BootstrapSettings): PlannedRole[] {
  const harnesses = runnableHarnesses(settings.agents ?? []);
  // Reserved unconditionally, not merely because the live install reports it:
  // its params are ShipIt's to resolve, and a settings read that somehow came
  // back without it must not turn into an attempt to create it.
  const taken = new Set<string>([RESERVED_ROLE_NAME, ...(settings.roles ?? []).map((r) => r.name)]);
  const planned: PlannedRole[] = [];
  const candidates = [
    ...RECIPES.map((recipe) => resolveRecipe(recipe, harnesses)),
    planUnavailableRole(harnesses),
  ];
  for (const candidate of candidates) {
    if (!candidate || taken.has(candidate.name)) continue;
    planned.push(candidate);
  }
  return planned;
}

// ---- HTTP -------------------------------------------------------------------

interface ApiResponse {
  ok: boolean;
  status: number;
  body: { error?: string; settings?: BootstrapSettings } | null;
}

export type FetchImpl = typeof globalThis.fetch;

/**
 * Thin JSON client. Returns the status rather than throwing on a non-2xx,
 * because every caller here treats an HTTP error as "log it and carry on with
 * the next role" (req 5).
 */
async function api(
  fetchImpl: FetchImpl,
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetchImpl(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: ApiResponse["body"] = null;
  try {
    parsed = (await res.json()) as ApiResponse["body"];
  } catch {
    // Empty or non-JSON body — the status is all we need.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Wait for the inner orch, and return the settings it answered with.
 *
 * One call does both jobs here, unlike the credential seeder's separate health
 * probe and list: `GET /api/bootstrap` carries `settings.agents` (the harnesses
 * and their eligible models) and `settings.roles` (what already exists), which
 * is the entire input this script needs.
 */
async function waitForSettings(
  fetchImpl: FetchImpl,
  baseUrl: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number; now?: () => number } = {},
): Promise<BootstrapSettings> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const now = opts.now ?? ((): number => Date.now());
  const deadline = now() + timeoutMs;
  let lastError = "no response";
  while (now() < deadline) {
    try {
      const res = await api(fetchImpl, baseUrl, "GET", "/api/bootstrap");
      if (res.ok) return res.body?.settings ?? {};
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = errorMessage(err);
    }
    await sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new Error(`inner orchestrator did not come up within ${timeoutMs}ms (${lastError})`);
}

export interface SeedRolesDeps {
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SeedRolesOpts {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

/**
 * Run the whole role seed. Dependency-injected so the unit tests drive it with a
 * fake `fetch` instead of a live orchestrator.
 */
export async function seedRoles(
  deps: SeedRolesDeps = {},
  opts: SeedRolesOpts = {},
): Promise<{ skipped: boolean; results: SeedRoleResult[] }> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? process.env.SEED_ORCH_URL ?? DEFAULT_BASE_URL;
  const env = deps.env ?? process.env;

  if (env.DOGFOOD_SEED === "0" || env.DOGFOOD_SEED_ROLES === "0") {
    log("roles: disabled — skipping");
    return { skipped: true, results: [] };
  }

  let settings: BootstrapSettings;
  try {
    settings = await waitForSettings(fetchImpl, baseUrl, opts);
  } catch (err) {
    log(`roles: ${errorMessage(err)}`);
    return { skipped: true, results: [] };
  }

  const harnesses = runnableHarnesses(settings.agents ?? []);
  if (harnesses.length === 0) {
    // The common case for anyone who supplied no service credential: there is no
    // harness a role could name, and a role naming one anyway would be stranded
    // rather than useful. Say why, and cost the boot nothing further.
    log("roles: no harness on this install can run a model yet — nothing to seed");
    return { skipped: true, results: [] };
  }

  const planned = planRoles(settings);
  if (planned.length === 0) {
    log("roles: every seeded role is already present — nothing to do");
    return { skipped: true, results: [] };
  }

  const results: SeedRoleResult[] = [];
  for (const role of planned) {
    // One PUT per role (req 5). `applyRoleWrites` validates the whole batch
    // before writing any of it, so a single batched write would let one refused
    // role take the others down with it.
    //
    // No `previousName`: every role here is a CREATE, guaranteed by the name
    // filter above. Sending one would claim to edit a role that does not exist.
    const body = {
      roles: {
        [role.name]: {
          description: role.description,
          ...(role.prompt ? { prompt: role.prompt } : {}),
          params: role.params,
        },
      },
    };
    try {
      const res = await api(fetchImpl, baseUrl, "PUT", "/api/settings", body);
      if (!res.ok) {
        const detail = res.body?.error ?? `HTTP ${res.status}`;
        log(`roles: ${role.name} — ${detail}`);
        results.push({ name: role.name, outcome: "failed", detail });
        continue;
      }
      log(`roles: ${role.name} — added as ${describe(role.params)}`);
      results.push({ name: role.name, outcome: "seeded" });
    } catch (err) {
      // req 5 — one bad entry must not stop the others.
      const detail = errorMessage(err);
      log(`roles: ${role.name} — ${detail}`);
      results.push({ name: role.name, outcome: "failed", detail });
    }
  }

  const seeded = results.filter((r) => r.outcome === "seeded").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  log(`roles: done — ${seeded} added, ${failed} failed`);
  return { skipped: false, results };
}

/** One role's tuple in a log line, in the same order the editor shows it. */
function describe(params: RolePinnedParams): string {
  return [
    params.harnessId,
    `${params.serviceId}/${params.billingMode}`,
    params.modelId,
    params.reasoningEffort ?? "Default",
  ].join(" · ");
}

// Entry point. Never exits non-zero: a seeding failure is a degraded dogfood
// loop, not a broken dev service (req 5).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedRoles().catch((err: unknown) => {
    log(`roles: unexpected failure: ${errorMessage(err)}`);
  });
}
