import type { AgentId } from "../src/server/shared/types.js";
import type { RolePinnedParams } from "../src/server/shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../src/server/shared/types/agent-types.js";
import { catalogueEntriesForHarness } from "../src/server/shared/catalogue/index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

const log = (msg: string): void => { console.log(msg); };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BootstrapAgent {
  id: string;
  name: string;
  installed: boolean;
  eligibleModels?: { serviceId: string; billingMode: "sub" | "key"; modelId: string; label: string }[];
  reasoning?: { options: { value: string; label: string }[] };
}

export interface BootstrapSettings {
  agents?: BootstrapAgent[];
  roles?: { name: string }[];
}

type LevelChoice = "highest" | "lowest" | "default";

export interface RoleRecipe {
  name: string;
  description: string;
  prompt?: string;
  harness: "primary" | "secondary";
  level: LevelChoice;
}

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

export const UNAVAILABLE_ROLE_NAME = "needs-a-credential";

export interface PlannedRole {
  name: string;
  description: string;
  prompt?: string;
  params: RolePinnedParams;
}

export interface SeedRoleResult {
  name: string;
  outcome: "seeded" | "skipped" | "failed";
  detail?: string;
}

export function runnableHarnesses(agents: readonly BootstrapAgent[]): BootstrapAgent[] {
  return agents.filter((a) => a.installed && (a.eligibleModels?.length ?? 0) > 0);
}

function levelFor(harness: BootstrapAgent, choice: LevelChoice): string | undefined {
  if (choice === "default") return undefined;
  const options = harness.reasoning?.options ?? [];
  if (options.length === 0) return undefined;
  const option = choice === "highest" ? options[options.length - 1] : options[0];
  return option?.value;
}

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

// Derive an unavailable role from this install; a hardcoded choice may be runnable.
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
          + `(${billingMode === "sub" ? "subscription" : "API key"}), which this install held `
          + `no credential for when it was seeded. Connect that service and it starts working.`,
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

export function planRoles(settings: BootstrapSettings): PlannedRole[] {
  const harnesses = runnableHarnesses(settings.agents ?? []);
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

interface ApiResponse {
  ok: boolean;
  status: number;
  body: { error?: string; settings?: BootstrapSettings } | null;
}

export type FetchImpl = typeof globalThis.fetch;

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
    // Status is sufficient for non-JSON responses.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

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
    // Write separately so one invalid role cannot reject the whole batch.
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

function describe(params: RolePinnedParams): string {
  return [
    params.harnessId,
    `${params.serviceId}/${params.billingMode}`,
    params.modelId,
    params.reasoningEffort ?? "Default",
  ].join(" · ");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedRoles().catch((err: unknown) => {
    log(`roles: unexpected failure: ${errorMessage(err)}`);
  });
}
