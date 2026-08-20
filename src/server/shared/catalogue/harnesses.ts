/**
 * docs/252 phase 1 — the harnesses ShipIt can run.
 *
 * A harness is an agent CLI plus the adapter that normalizes its event stream.
 * The set is ShipIt's, not a user's (req 14); which harnesses an *install* has is
 * the `SHIPIT_HARNESSES` build input (phase 9).
 *
 * **Adding a row here means adding one to `docker/agent-cli/install-agent-clis.sh`**
 * — its npm package and its binary — or the image can never install it.
 * `agent-cli-install.test.ts` fails the build if the two disagree.
 *
 * What is NOT here: Cursor CLI. The survey in
 * `docs/252-custom-models/catalogue.md` records what it appears to need — and
 * already paid for itself by making `styles` a set and giving `SpawnShape` a
 * config-file variant — but it is not a harness ShipIt runs, it has no honest
 * `capabilities` block to declare, and req 14 governs what an install actually
 * has. OpenCode and Grok Build both graduated from that survey to rows, via
 * `docs/268-opencode-harness` and `docs/274-grok-build-harness` (empirical
 * findings in each plan.md).
 */

import { CLAUDE_PERMISSION_MODES, GROK_PERMISSION_MODES } from "../types/agent-types.js";
import { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES, GROK_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "../agent-tool-names.js";
import type { HarnessDef } from "./types.js";

export const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    nativeService: "anthropic",
    // VERIFIED (phase 3, CLI 2.1.220, against a local HTTP recorder). Pointed at
    // an arbitrary `ANTHROPIC_BASE_URL` the CLI issues
    // `POST <base>/v1/messages?beta=true` with an Anthropic Messages body — so a
    // service's base URL must NOT carry the `/v1`, which is why DeepSeek's is
    // `…/anthropic` and OpenRouter's `…/api`.
    styles: ["anthropic-messages"],
    spawn: {
      credential: {
        // `ANTHROPIC_API_KEY`, not `ANTHROPIC_AUTH_TOKEN`: the repo distinguishes
        // them as two different reserved routes (`claude-api-key` vs
        // `claude-env-oauth`) and `setApiKey()` writes the former. Verified at
        // the wire in the same run: `ANTHROPIC_API_KEY` becomes an `x-api-key`
        // header and `ANTHROPIC_AUTH_TOKEN` an `Authorization: Bearer` one, which
        // is exactly why `targetOverride` exists and why GLM needs it.
        string: { kind: "env", name: "ANTHROPIC_API_KEY" },
        account: { kind: "scoped-home" },
      },
      // Verified: `--model` is forwarded VERBATIM into the request body. The one
      // exception is the CLI's own `[1m]` suffix, which it consumes to select the
      // long-context variant and strips before sending (`glm-5.2[1m]` arrives as
      // `glm-5.2`) — so the suffix in GLM's row is a Claude-Code instruction, not
      // an id the service ever sees.
      model: { kind: "flag", flag: "--model" },
      endpoint: { kind: "env", name: "ANTHROPIC_BASE_URL" },
    },
    capabilities: {
      supportsResume: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      supportsPermissionModes: true,
      supportedPermissionModes: CLAUDE_PERMISSION_MODES,
      toolNames: [...CLAUDE_TOOL_NAMES],
      // Claude Code CLI `--effort <level>`. Verified valid values by running
      // `claude --effort __bogus__`: "low, medium, high, xhigh, max". Omitting
      // the flag uses the model's adaptive default. See docs/217.
      reasoning: {
        label: "Reasoning",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
      supportsReview: true,
      supportsSteering: true,
      // docs/140 Phase 6.11 — the streaming CLI is ONE resident process across
      // turns, so it can start one ShipIt never asked for.
      startsOwnTurns: true,
      supportsCompaction: true,
      skillsDirName: ".claude",
      skillInvocationPrefix: "/",
    },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    nativeService: "openai",
    // VERIFIED (phase 3, codex-cli 0.146.0, against a local HTTP recorder).
    // Responses is the ONLY style this CLI still speaks: a provider declaring
    // `wire_api = "chat"` is rejected outright with "set `wire_api =
    // \"responses\"` in your provider config", so `openai-chat-completions`
    // could not be added to this set even if a service offered it.
    styles: ["openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "OPENAI_API_KEY" },
        account: { kind: "scoped-home" },
      },
      model: { kind: "turn-payload", field: "model" },
      // Verified: `model_provider` names a block in `model_providers`, it is not
      // a base URL of its own (`-c model_provider=<url>` fails with "Model
      // provider `…` not found"). So the seam is a whole provider block —
      // `name`, `base_url`, `wire_api`, `env_key` — plus `model_provider`
      // pointing at it, which `codex/spawn-shaping.ts` writes. The key here is
      // the base-URL field WITHIN that block; the block's id is the adapter's.
      // Codex appends `/responses` to `base_url`, so a Responses base URL
      // carries its own `/v1` where an Anthropic one does not.
      endpoint: { kind: "config", key: "base_url" },
    },
    capabilities: {
      supportsResume: true,
      supportsImages: false,
      supportsSystemPrompt: true,
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: [...CODEX_TOOL_NAMES],
      // Codex CLI config `model_reasoning_effort`. Verified valid values by
      // running `codex -c model_reasoning_effort=__bogus__`: "none, minimal,
      // low, medium, high, xhigh". See docs/217.
      reasoning: {
        label: "Reasoning effort",
        options: [
          { value: "none", label: "None" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
        ],
      },
      // docs/266 item 15 — the chat-native review flow needs a shell tool and a
      // subagent primitive (`spawn_agent`), and no MCP surface: docs/220
      // deleted the last `submit_review` write path, so the flow is a plain
      // chat message the harness answers with its ordinary tools.
      supportsReview: true,
      supportsSteering: true,
      // docs/140 Phase 6.11 — the app-server is killed at `turn/completed`, and
      // it emits the turn's final assistant text AFTER that. Those late events
      // belong to the turn that just ended, not to a new one.
      startsOwnTurns: false,
      supportsCompaction: true,
      skillsDirName: ".codex",
      skillInvocationPrefix: "$",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    // docs/272 — the follow-up docs/268 deferred: OpenCode's own inference
    // (Zen + Go) now has honest `ServiceDef` rows, so this CLI has a native
    // service. What it buys is attribution — on native + key the metered-spend
    // column may use the harness's OWN figure, and OpenCode reports one (every
    // Zen/Go response body carries a top-level `cost`, docs/272 §5).
    //
    // What it must NOT be read as: unlike claude and codex, this native service
    // has no account machinery — no login flow, no OAuth heal — and an
    // UNSHAPED OpenCode spawn cannot authenticate at all (the adapter refuses a
    // turn with no routing). Three places used "native service" as a stand-in
    // for "the vendor's account machinery owns this", and all three now ask
    // `loginIntegrationForService` as well: `credential-failure-policy.ts`,
    // `session-agent-env.ts` (the planning#353 write and the blocked-turn
    // subject) and `services/settings.ts`. Adding a fourth reader of
    // `nativeService` means asking which of the two questions it wants.
    nativeService: "opencode",
    //
    // VERIFIED (docs/268, CLI 1.18.15, against a local HTTP recorder). A
    // custom provider block with `npm: "@ai-sdk/openai-compatible"` issues
    // `POST <base>/chat/completions` with a Bearer token, and
    // `npm: "@ai-sdk/anthropic"` issues `POST <base>/messages` with
    // `x-api-key` + `anthropic-version`. Both base URLs must carry their own
    // `/v1` — for anthropic-messages that is the OPPOSITE of Claude Code's
    // convention (Claude appends `/v1/messages`, OpenCode only `/messages`),
    // so the adapter appends `/v1` to catalogue A_MSG endpoints when it
    // writes the provider block. Order is preference: chat-completions first
    // (OpenCode's dominant native path; reasoning delivery fully verified).
    styles: ["openai-chat-completions", "anthropic-messages"],
    spawn: {
      credential: {
        // The adapter writes a per-turn provider block whose `apiKey` is
        // `{env:OPENCODE_PROVIDER_API_KEY}` — a ShipIt-chosen variable, so
        // one delivery works for every service. Deliberately NO `account`
        // target (docs/268 req 5): the eligibility join then structurally
        // excludes every `via: "account"` mode (Anthropic OAuth, ChatGPT) —
        // upstream removed Anthropic subscription login, and ShipIt's
        // ChatGPT/Copilot OAuth wiring for OpenCode is follow-up work.
        string: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
        account: undefined,
      },
      // `opencode run --model shipit/<modelId>` — the adapter always routes
      // through its own `shipit` provider block, never OpenCode's built-in
      // registry, so the flag value is `shipit/<modelId>` (docs/268 plan.md,
      // "serviceId → provider/model").
      model: { kind: "flag", flag: "--model" },
      // The base URL lives in the per-turn config file's provider block; the
      // CLI has no endpoint env var or flag.
      endpoint: { kind: "config-file", path: "opencode.json", pointer: "/provider/shipit/options/baseURL" },
    },
    capabilities: {
      // `-s <sessionID>` verified live (docs/268 Phase 0): recall across
      // processes.
      supportsResume: true,
      // Honest per docs/268 req 6: `-f` exists but an image turn was never
      // OBSERVED (no vision model reachable in the verification container),
      // and a wrong true surfaces as broken attachments at runtime. Flip after
      // a live probe.
      supportsImages: false,
      // Config `instructions` array — the adapter points it at the rendered
      // system-prompt file.
      supportsSystemPrompt: true,
      // Headless runs are `--auto` (full auto inside the container sandbox);
      // no brokered permission gate at launch.
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: [...OPENCODE_TOOL_NAMES],
      // `opencode run --variant <level>` — per-model named variants sourced
      // from models.dev. Observed vocabulary across Anthropic/OpenAI/DeepSeek
      // entries (docs/268 plan.md): none…max; an unknown variant is SILENTLY
      // ignored (verified: `--variant totally-bogus` exits 0), so this list —
      // not the CLI — is the validation. The adapter writes a `variants` map
      // into its provider block so these levels exist for every model it
      // routes.
      reasoning: {
        label: "Reasoning variant",
        options: [
          { value: "none", label: "None" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
      // PROBED true (planning#459, CLI 1.18.15, 2026-08-20). The old comment
      // here — "no chat-native review flow wired for this backend yet" — was
      // inherited from docs/125's rule that review needs subagents AND custom
      // MCP tool registration. That rule is dead: docs/220 removed the last
      // `submit_review` write path, so the flow is a plain chat message
      // (`compose-review-body.ts`) and no MCP tool is involved at all. What it
      // actually needs is a shell tool and a subagent primitive — docs/266
      // item 15 — and OpenCode has `bash` and `task`.
      //
      // Probed at depth 0, with the real composed message, because a
      // `shipit agent run` nested inside one is refused by the caller-depth
      // guard whatever the harness: an `opencode` session given
      // `composeReviewMessage(path, { mode: "role" })` ran
      // `shipit agent run --role reviewer --prompt-file -` itself (brief on
      // stdin via heredoc), exit 0, and came back with four material findings.
      // A second run exercised the other branch — on a non-zero exit it fell
      // back to a `task` subagent and returned markdown only, as the prompt
      // instructs.
      supportsReview: true,
      // One-shot spawn per turn, prompt as argv — no mid-turn steering
      // channel.
      supportsSteering: false,
      // The process exits at turn end; it cannot start a turn ShipIt never
      // asked for.
      startsOwnTurns: false,
      // VERIFIED true (CLI 1.18.18, live-probed — docs/276). The trigger is
      // NOT on `opencode run`; it is the server's documented
      // `POST /session/{id}/summarize` (opencode.ai/docs/server), which the
      // adapter reaches by spawning a transient `opencode serve`.
      //
      // Two `run`-shaped triggers were tested and BOTH fail — do not retry
      // them without re-probing:
      //  - `/compact` as the prompt is an ORDINARY prompt (it reaches the
      //    model verbatim and burns a turn), the exact opposite of Claude.
      //  - `--command compact` fails identically to `--command
      //    __definitely_bogus__` (same `UnknownError` at `SessionPrompt
      //    .command`); `--command` resolves REGISTERED commands only, and
      //    `compact` is not one — `init` is, and succeeds, which is the
      //    control proving the flag itself works.
      // The v2 route `POST /api/session/{id}/compact` is in the OpenAPI doc
      // but returns 503 `"Session compact is not available yet"` — declared,
      // not implemented. That unimplemented route is the likeliest source of
      // the `/compact` string in the binary.
      //
      // Outcome measured, not just exit status: a probe turn's reported
      // context went 16,684 → 6,250 tokens across the call, and against a
      // recording proxy the pre-compaction turns disappear from the next
      // request, replaced by a summary produced by OpenCode's own
      // "context summarization agent".
      supportsCompaction: true,
      skillsDirName: ".opencode",
      skillInvocationPrefix: "/",
    },
  },
  {
    // docs/274 — the fourth harness. Grok Build imitates Claude Code's flag
    // surface closely enough that the adapter is the Claude shape (spawn per
    // turn, NDJSON on stdout), which is what made this integration small.
    id: "grok",
    name: "Grok Build",
    binary: "grok",
    // xAI is a real native service for this CLI, and since planning#435 it
    // carries account machinery too: the subscription (SuperGrok / X Premium+)
    // is reached by the CLI's own `grok login --device-auth`, whose cached
    // `auth.json` ShipIt injects. So `nativeService` now means both "whose
    // models and whose bill" and "whose account system".
    nativeService: "xai",
    // VERIFIED (docs/274 Phase 0, CLI 1.0.1, against a local HTTP recorder).
    // ONE CLI, TWO styles: an explicit `-m` turn goes to
    // `POST <base>/chat/completions` with `stream_options: {include_usage}`,
    // while the session-title side-call rides `POST <base>/responses`. The
    // adapter always passes `-m`, so chat-completions is the path a turn
    // actually takes and is listed first; `openai-responses` is here because
    // dropping it would make the catalogue claim an endpoint the CLI reaches
    // is unreachable. Neither base URL takes a suffix from the CLI, so xAI's
    // endpoints carry their own `/v1`.
    styles: ["openai-chat-completions", "openai-responses"],
    spawn: {
      credential: {
        string: { kind: "env", name: "XAI_API_KEY" },
        // ON since planning#435, in the same change as the `xai-oauth` manager
        // that runs the flow — never before it. `catalogue.test.ts` refuses a
        // `LoginIntegrationId` no manager implements, and that guard is right:
        // an account target without one would let the eligibility join offer a
        // subscription no ShipIt surface can sign into.
        //
        // `scoped-home` because the credential IS xAI's own login — a
        // `~/.grok/auth.json` the CLI reads from whatever `GROK_HOME` names, so
        // pointing the spawn at the account root is the whole delivery. Note
        // that pointing it there is NOT sufficient on its own: grok prefers
        // `XAI_API_KEY` over the file, so the adapter must also scrub (see
        // `spawn-routing.ts`'s `HARNESS_CREDENTIAL_VARS`).
        account: { kind: "scoped-home" },
      },
      // `grok -p … -m <modelId>`. Verified forwarded verbatim: the id also
      // appears in an `x-grok-model-override` request header.
      model: { kind: "flag", flag: "-m" },
      endpoint: { kind: "env", name: "GROK_XAI_API_BASE_URL" },
    },
    capabilities: {
      // Verified live: `-r <id>` re-inits with the SAME session_id and recalls
      // the previous turn's facts. ShipIt additionally PRE-ASSIGNS the id with
      // `-s <uuid>` on the first turn rather than parsing one out.
      supportsResume: true,
      // VERIFIED false, not assumed (docs/274 req 7). `--prompt-json` accepts
      // an ACP image content block without complaint, so the syntactic surface
      // exists — but with the image data present ONLY inside the prompt (never
      // written to disk) and a randomized colour pair, grok-4.6 answered
      // "unknown unknown" in a single turn. The block is accepted and its
      // content does not reach the model as vision.
      //
      // The probe is recorded because the FIRST two attempts appeared to
      // succeed and were wrong: the model had reached the answer off the
      // filesystem, which a no-image negative control exposed by answering
      // identically. `image_gen`/`image_edit` in the tool list are OUTPUT
      // tools and say nothing about input.
      supportsImages: false,
      // `--system-prompt-override` replaces the prompt, `--rules` appends.
      supportsSystemPrompt: true,
      supportsPermissionModes: true,
      supportedPermissionModes: GROK_PERMISSION_MODES,
      toolNames: [...GROK_TOOL_NAMES],
      // The vocabulary, and the ONE mode that sends it (docs/274 req 14).
      //
      // `--reasoning-effort` is not universally dropped and it is not
      // universally honoured: under a SUBSCRIPTION the CLI puts it on the wire,
      // recorder-verified with a negative control
      // (`reasoning:{effort:"xhigh"}` with the flag against
      // `reasoning:{effort:"high"}` without), and under an API key no effort
      // field reaches the request body for any model probed.
      //
      // So the four levels are named here — they are what the CLI understands —
      // and `billingModes: ["sub"]` is what keeps them off every key-billed
      // selection, including the gateway rows Grok shares with Claude, Codex
      // and OpenCode (`x-ai/grok-4.6` at OpenRouter and Vercel, DeepSeek, GLM).
      // Those three DO honour levels there, which is exactly why the gate
      // cannot live on the rows: no per-row value is right for all four
      // harnesses at once. `reasoningOptionsFor` is the composition; nothing
      // should read `options` directly.
      //
      // Order is the picker's order, strongest first, and matches the CLI's own
      // `reasoning_efforts` list for grok-4.6.
      reasoning: {
        label: "Reasoning",
        options: [
          { value: "xhigh", label: "Extra high" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        billingModes: ["sub"],
      },
      // PROBED true (planning#459, CLI 1.0.1, 2026-08-20). "Unexercised as a
      // reviewer at launch" described the wrong thing twice over: this flag is
      // not about being a reviewer — a reviewer is a MODEL whose harness is
      // derived, and `reviewer-model.ts` never reads it — and the flow it does
      // gate needs no MCP surface since docs/220 deleted the last
      // `submit_review` write path. The requirement is a shell tool and a
      // subagent primitive (docs/266 item 15); Grok has `run_terminal_command`
      // and `spawn_subagent`.
      //
      // Probed at depth 0, with the real composed message, because a nested
      // `shipit agent run` is refused by the caller-depth guard whatever the
      // harness: a `grok` session given
      // `composeReviewMessage(path, { mode: "role" })` ran
      // `shipit agent run --role reviewer --prompt-file -` itself, exit 0, and
      // came back with three material findings. A second run exercised the
      // other branch — on a non-zero exit it fell back to `spawn_subagent` and
      // returned markdown only, as the prompt instructs.
      //
      // Worth knowing when a review here looks stuck: that run took 240s and
      // `run_terminal_command` gives up the foreground after 120s. It does not
      // kill the process — it backgrounds it, and the model reads it to
      // completion with `get_command_or_subagent_output`. That is why the flag
      // is true; a shell tool that killed instead would fail the branch.
      supportsReview: true,
      // One-shot spawn per turn, prompt as argv — no mid-turn steering channel.
      supportsSteering: false,
      // The process exits at turn end; it cannot start a turn ShipIt never
      // asked for.
      startsOwnTurns: false,
      // VERIFIED true (CLI 1.0.1, live-probed — docs/276). Grok's trigger is
      // IN-BAND, the Claude shape: `/compact` in the prompt is intercepted by
      // the CLI in headless mode, so the adapter needs no special argv — the
      // orchestrator's existing `run({ compact: true })` spawn (whose prompt
      // already IS `/compact`) is the whole mechanism. Confirmed through
      // `--prompt-file`, which is how this adapter passes every prompt, and
      // with `prefixPromptWithNotice`'s trailing notice appended.
      //
      // Two negative controls prove interception rather than a lucky reply:
      // `/__definitely_bogus__` and `/compact-mode` both run as ORDINARY
      // prompts (full `usage` block, model answers), while `/compact` alone
      // returns empty text with NO usage block and no model call.
      //
      // Outcome measured, not just exit status: a probe turn's reported
      // context went 24,117 → 10,394 tokens across the call, and the session
      // store gains `compaction_requests/<id>.json` with `"trigger":
      // "manual"` plus a `compaction_checkpoints/` entry whose
      // `compacted_history` has replaced the transcript with a continuation
      // summary. The CLI also ADVERTISES the command: `system/init` carries
      // `slash_commands: ["compact", …]`.
      //
      // One subtlety worth knowing before reading the adapter: the wire's
      // `compact_metadata.trigger` is ALWAYS `"auto"`, even here. The adapter
      // labels manual-vs-auto by correlation instead and never reads it.
      supportsCompaction: true,
      // Verified live (docs/209 probe): Grok auto-discloses skills from BOTH
      // `.grok/skills/` and `.claude/skills/` via its claude-compat layer, so
      // no symlink is needed — but its OWN directory is the one to declare.
      skillsDirName: ".grok",
      skillInvocationPrefix: "/",
    },
  },
] as const satisfies readonly HarnessDef[];

/**
 * There is deliberately **no model-switching capability flag**. Req 4's "as far
 * as that harness supports it" is currently carried by nothing because both
 * shipped harnesses support it unconditionally — the model is per-turn data for
 * each. A capability with one possible value is noise; `AgentCapabilities` gains
 * the flag if and when a candidate turns up that fixes its model at process start.
 */
export type ShippedHarness = (typeof HARNESSES)[number];
