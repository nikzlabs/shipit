/**
 * docs/252 — pointing a spawn at the selected model's service, for both
 * harnesses, in a module **either side of the container boundary may import**.
 *
 * Phase 3 wrote these two helpers where their spawns live: `applyServiceRouting`
 * inside the Claude adapter's process module and `codexProviderArgs` beside the
 * Codex one, both under `src/server/session/`. That was right while the only
 * caller was a worker-side spawn. Phase 7 adds a second caller on the other
 * side of the boundary — session naming shells out to a CLI from the
 * **orchestrator** (`session-namer.ts`), which must not import `session/` at
 * all: the prod image omits that tree precisely to keep the boundary honest
 * (`app-di.ts`, "loaded lazily via dynamic import").
 *
 * So the shaping rules move here — pure functions over a `ServiceRouting` and
 * nothing else — and the two session-side modules re-export them for their
 * existing importers and tests. Nothing about the rules changed in the move;
 * the alternative was a second implementation in the orchestrator, which is how
 * a naming turn ends up authenticating differently from the turn it names.
 */

import { MODEL_CONTEXT_WINDOWS } from "./model-windows.js";
import type { AgentId, ServiceRouting } from "./types.js";
import type { ApiStyle } from "./catalogue/types.js";

/** Every Anthropic credential variable the CLI will read, in preference order. */
const ANTHROPIC_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Every environment credential each harness's CLI prefers over its on-disk login. */
const HARNESS_CREDENTIAL_VARS: Record<AgentId, readonly string[]> = {
  claude: ANTHROPIC_CREDENTIAL_VARS,
  codex: ["OPENAI_API_KEY"],
  // OpenCode auto-detects every well-known provider key env var (verified in
  // docs/268: a bare DEEPSEEK_API_KEY was picked up with no config), plus its
  // own gateway/auth vars and ShipIt's provider-block delivery variable — all
  // of which would out-prefer on-disk credentials and silently re-route
  // billing.
  opencode: [
    "OPENCODE_PROVIDER_API_KEY",
    "OPENCODE_API_KEY",
    "OPENCODE_AUTH_CONTENT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  // Grok reads `XAI_API_KEY` in preference to its on-disk `~/.grok/auth.json`
  // login (the unauthenticated CLI names both sources itself, and T3 Code
  // picks between them on exactly this variable) — so an inherited one would
  // silently bill a scoped-home spawn to the wrong account. `GROK_AUTH` /
  // `GROK_AUTH_PATH` are here for the same reason one step removed: they
  // redirect the CLI at a *different* token store, which defeats the scoped
  // home just as thoroughly as a key would.
  grok: ["XAI_API_KEY", "GROK_AUTH", "GROK_AUTH_PATH"],
};

/**
 * docs/150 / docs/252 — drop the environment credentials a CLI would prefer over
 * the account login on disk, for a spawn scoped to a provider-account root.
 *
 * Pointing `HOME` at an account root is not enough on its own: both CLIs prefer
 * their environment variable over the OAuth credentials on disk, so a host that
 * has one configured — the dogfood `dev` service does, see `CLAUDE.md` — keeps
 * billing metered API usage while the router believes the run is on the selected
 * subscription. The adapters already do this at their own spawn sites
 * (`scrubEnvAuthForScopedHome`, and Codex's `delete env.OPENAI_API_KEY`); this is
 * the same rule for the **orchestrator's** own CLI shell-out, which builds its
 * environment itself.
 *
 * Deliberately only when a scoped home applies: a run on a reserved env/API-key
 * route resolves no account root and must keep exactly those variables — they
 * are its auth.
 */
export function scrubHarnessEnvCredentials(env: Record<string, string>, harnessId: AgentId): void {
  for (const name of HARNESS_CREDENTIAL_VARS[harnessId]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key set is the module-level literal above, not caller input.
    delete env[name];
  }
}

/**
 * docs/252 phase 3 — point this spawn at the selected model's service.
 *
 * **Must run AFTER the scoped-home auth scrub** where one applies, and the
 * ordering is load-bearing rather than incidental: the scrub deletes the very
 * variables this writes, so shaping first would produce a spawn with an
 * endpoint and no credential — a redirected turn that 401s. A test pins the
 * order.
 *
 * Two things happen and both are deliberate:
 *
 *  - **Every Anthropic credential variable is cleared first, then exactly one is
 *    set.** They are not interchangeable at the wire (`ANTHROPIC_API_KEY`
 *    becomes an `x-api-key` header, `ANTHROPIC_AUTH_TOKEN` an
 *    `Authorization: Bearer` one — measured, not assumed), and the CLI prefers
 *    the key. Leaving a stale one behind is how a GLM turn would authenticate
 *    with an Anthropic key against GLM's endpoint.
 *  - **The base URL is set from the catalogue, unconditionally for a shaped
 *    turn.** Inheriting an ambient `ANTHROPIC_BASE_URL` would make where a turn
 *    goes depend on the orchestrator's own environment rather than on what the
 *    user selected.
 *
 * A turn with nothing to shape — the harness on its own vendor through a login
 * account — passes `undefined` and this is a no-op, which is what keeps today's
 * spawn byte-identical for the common case.
 */
export function applyServiceRouting(
  env: Record<string, string>,
  routing: ServiceRouting | undefined,
): { credentialDelivered: boolean } {
  if (!routing) return { credentialDelivered: true };
  const secret = env[routing.credentialSourceEnv];
  for (const name of ANTHROPIC_CREDENTIAL_VARS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key set is the module-level literal above, not caller input.
    delete env[name];
  }
  const credentialDelivered = routing.credentialTarget.kind === "env" && !!secret;
  if (credentialDelivered && routing.credentialTarget.kind === "env") {
    env[routing.credentialTarget.name] = secret;
  }
  env.ANTHROPIC_BASE_URL = routing.baseUrl;
  return { credentialDelivered };
}

/**
 * The provider-block name ShipIt writes under.
 *
 * A fixed name rather than one derived from the `serviceId`, because the block
 * is created fresh per spawn and only ever has one occupant: the turn's own
 * service. A per-service name would accumulate blocks in a user's
 * `config.toml`-shaped override set for no gain, and would collide with a
 * provider the user configured under the same name.
 */
export const SHIPIT_PROVIDER_ID = "shipit";

/** A trailing Claude-Code variant suffix, e.g. the `[1m]` in `glm-5.2[1m]`. */
const VARIANT_SUFFIX = /\[[^\]]*\]$/;

/** The window at which Claude Code needs telling, via `[1m]`, that it may go past 200K. */
const LONG_CONTEXT_TOKENS = 1_000_000;

/**
 * The `--model` value for a Claude Code spawn: the catalogue id, plus `[1m]`
 * when the model has a 1M window.
 *
 * **Why this is needed at all.** Claude Code carries a fixed list of model ids,
 * and CLI 2.1.251 changed what it does with an id outside that list: auto-compact
 * now holds the session to the 200K window it *assumes*, where it used to wait
 * for the API's answer. Every model ShipIt drives through this harness that
 * Anthropic did not ship — DeepSeek's, the gateways' rows, OpenCode Zen's, and
 * Anthropic's own `claude-fable-5-1`, which the pinned CLI predates — is such an
 * id, so a 1M model selected in ShipIt silently ran at a fifth of its window and
 * compacted five times as often. MEASURED on CLI 2.1.251, reading
 * `result.modelUsage.<model>.contextWindow`: `claude-fable-5-1` reports 200_000
 * and `claude-fable-5-1[1m]` reports 1_000_000, against `claude-opus-5` (a
 * recognized id) reporting 1_000_000 either way.
 *
 * `[1m]` and not `CLAUDE_CODE_MAX_CONTEXT_TOKENS`: that variable is a **cap**
 * (`Math.min` against the assumed window), so it can lower a window and never
 * raise one — setting it to 1M silences the CLI's startup notice while leaving
 * the session at 200K, which is the worst of both.
 *
 * The suffix is a Claude-Code instruction, not an id: the CLI consumes it and
 * strips it before the request goes out, which is why it may only be added HERE,
 * at this harness's spawn, and never to a catalogue row shared with a harness
 * that would forward it verbatim. (GLM's rows spell it inline because their mode
 * is `carriers: ["claude"]`; Anthropic's key mode is not — OpenCode can carry it.)
 * An id that already carries a suffix is returned untouched.
 *
 * {@link unshapeClaudeModelId} is the exact inverse, for the id the CLI reports
 * back.
 */
export function claudeModelArg(modelId: string): string {
  if (VARIANT_SUFFIX.test(modelId)) return modelId;
  // Exact lookup only. `getContextWindowForModel`'s substring fallback would
  // guess a window for an id the catalogue has no row for, and guessing HIGH
  // here tells the CLI not to compact a session that really is 200K.
  if ((MODEL_CONTEXT_WINDOWS[modelId] ?? 0) < LONG_CONTEXT_TOKENS) return modelId;
  return `${modelId}[1m]`;
}

/**
 * The catalogue id behind a model the Claude CLI reports back, undoing
 * {@link claudeModelArg}.
 *
 * The CLI echoes the `--model` value verbatim in `system.init` and as the
 * `modelUsage` key, so without this a ShipIt-appended suffix leaks into the
 * usage row's `model`, the Usage modal's label, and the harness-switch "keep the
 * model" lookup — none of which have a row for `claude-fable-5-1[1m]`.
 *
 * Two guards rather than a blanket strip, and both are load-bearing. A reported
 * id the catalogue already knows is returned as-is — `glm-5.3[1m]` IS a row id,
 * and stripping it would hand every downstream lookup a *different* row
 * (`glm-5.3`, the metered-key one). And past that, only a suffix
 * `claudeModelArg` would itself have produced is removed, so a `[…]` that came
 * from somewhere else survives instead of being silently rewritten.
 */
export function unshapeClaudeModelId(reported: string): string {
  if (MODEL_CONTEXT_WINDOWS[reported] !== undefined) return reported;
  if (!VARIANT_SUFFIX.test(reported)) return reported;
  const stripped = reported.replace(VARIANT_SUFFIX, "");
  return claudeModelArg(stripped) === reported ? stripped : reported;
}

/** Codex's `wire_api` value for a resolved style, or `undefined` if it has none. */
export function wireApiForStyle(style: ApiStyle): string | undefined {
  return style === "openai-responses" ? "responses" : undefined;
}

/**
 * The `-c` overrides that point this spawn at `routing`, or `[]` when there is
 * nothing to shape.
 *
 * Returns nothing rather than a partial block for a style Codex cannot speak:
 * a half-written provider would be rejected at startup, and a turn that runs
 * against OpenAI because its override was dropped is worse than one that does
 * not start. The catalogue join already prevents the case — no model reaches
 * this harness under a style it does not declare — so this is the backstop for
 * a row edited under a running install.
 */
export function codexProviderArgs(routing: ServiceRouting | undefined): string[] {
  if (!routing) return [];
  const wireApi = wireApiForStyle(routing.style);
  if (!wireApi || routing.credentialTarget.kind !== "env") return [];
  const p = `model_providers.${SHIPIT_PROVIDER_ID}`;
  return [
    "-c", `${p}.name=${routing.serviceName}`,
    "-c", `${p}.base_url=${routing.baseUrl}`,
    "-c", `${p}.wire_api=${wireApi}`,
    "-c", `${p}.env_key=${routing.credentialTarget.name}`,
    "-c", `model_provider=${SHIPIT_PROVIDER_ID}`,
  ];
}
