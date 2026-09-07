---
title: ChatGPT subscriptions in OpenCode — design
description: Reuse OpenAI login and quota, with an access-token projection for OpenCode.
---

# ChatGPT subscriptions in OpenCode

This is a proposed implementation design. Production behavior is unchanged.
The acceptance conditions are in [requirements.md](./requirements.md), and
remaining implementation work is in [checklist.md](./checklist.md).

## Decision

Keep the existing `openai-chatgpt` login and its canonical Codex credential
root. Add OpenCode as a consumer of that account. Deliver only the current
access token, expiry, and ChatGPT account identity to OpenCode's built-in
OpenAI provider. Keep the refresh token in the existing OpenAI account path;
do not give it to OpenCode or translate OpenCode writes back into that path.

Use the native `openai/<model>` provider for this route. Keep the current
`shipit/<model>` provider for string credentials. This is an explicit route
choice, not a fallback when routing is missing.

This design has a compatibility gate: the pinned OpenCode CLI must consume
an access-only OAuth projection and read a replaced projection on subsequent
requests. The pinned auth schema accepts an empty refresh string, and `Auth.get` reads
the file again. A runtime probe must establish
it before the catalogue exposes the route. If it fails, keep the route closed
and revise this design; do not ship a refresh-token copy as a shortcut.

[Account flow diagram](./account-flow.svg) shows the ownership boundary.

## User flow

1. In Settings, the user connects ChatGPT through the existing OpenAI account
   control. An already connected user skips this step.
2. On a new session, the user chooses OpenCode, OpenAI, a supported model, and
   subscription billing. Existing account selection preferences apply.
3. ShipIt prepares the selected account before starting OpenCode. The account
   and quota shown are the same ones Codex uses.
4. If the token needs renewal, ShipIt renews it. If sign-in is required, the
   existing account control shows that condition. Quota exhaustion follows
   existing same-service, same-billing-mode failover.
5. Disconnect removes OpenCode's access-token projection as well as the
   existing account credentials. The OpenCode conversation database remains.

No new screen, shell action button, or transcript card is needed. Any existing
card reused for an error must keep its persistence and session ownership.

## Evidence and limits

Checked on 2026-09-07. Read source, not live account credentials.

| Finding | Verified source | Consequence |
|---|---|---|
| OpenCode documents ChatGPT Plus/Pro login | [Provider documentation](https://opencode.ai/docs/providers/#openai) | Upstream support exists. This is not an OpenCode API-key-only limitation. |
| The repo pins OpenCode 1.18.25 | `docker/agent-cli/package.json` | Probe this version, not an unpinned latest binary. |
| Every current ShipIt spawn disables default OpenCode auth components | `session/agents/opencode/adapter.ts`, `session-namer.ts`; [pinned loader](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/plugin/index.ts) | Explicitly enable and constrain native auth for this route; test with the complete ShipIt spawn configuration. |
| Native OpenAI auth uses OAuth, account headers, and the Codex Responses endpoint | [Pinned OpenCode source](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/plugin/openai/codex.ts), auth loader | A generic API-key provider block does not activate this path. |
| The loader calls `getAuth()` per fetch and refreshes only for missing/expired access | Same source, `auth.loader` | Access-only delivery is plausible. The pinned `auth/index.ts:Auth.get` also reads the file per call; end-to-end replacement still needs a runtime check. |
| Native OAuth filters models and can replace context limits | Same source, `provider.models` | Adding all ShipIt OpenAI models would make false promises. Probe the intersection and effective limits. |
| ChatGPT currently lists only Codex as a carrier | `shared/catalogue/services.ts`, OpenAI subscription mode | Eligibility must change only after delivery works. |
| OpenCode has no account target or Responses style | `shared/catalogue/harnesses.ts`, OpenCode row | A UI-only change cannot enable this route. |
| Account roots remain harness-shaped | `shared/catalogue/index.ts`, login integration mapping; `provider-account-manager.ts` | Preserve `provider-accounts/codex/<accountId>`. Do not infer ownership from the consuming harness. |
| Token repush resolves source paths using the harness and has no OpenCode token row | `token-sync-manager.ts:repushProviderAccountToken`, `AGENT_TOKEN_FILES` | Existing sync does not provide cross-format projection. Add an explicit one-way path. |
| Refresh has per-account in-flight state | `agents/codex/oauth-refresher.ts:runTickForAccount` | Reuse it for OpenCode. It serializes this refresher, not all existing Codex CLI refresh activity. |
| Codex has no awaited freshness hook: the dispatcher returns true without work | `bootstrap-managers.ts:ensureTokenFreshHooks` | Add an awaited OpenAI refresh adapter; dispatching with `codex` alone does not renew a token. |
| Pre-turn freshness is container-only and fail-open | `session-agent-env.ts`, Step 2a | It is insufficient as OpenCode's credential admission gate. |
| Recovery currently requires the harness's native service | `credential-failure-policy.ts:credentialFailurePolicyForRoute` | OpenCode/OpenAI needs login-owner recovery, not OpenCode Zen recovery. |
| OpenCode state and auth share an XDG data directory | `session-credentials-scaffold.ts:AGENT_CREDENTIAL_PATHS`; `session-namer.ts`, OpenCode case | Never replace the whole directory to change account. Naming's isolated XDG directory needs its own projection. |

Local source paths in this table are under `src/server/` unless stated
otherwise. No authenticated call has been run for this design. Documentation
support is not a measurement of model entitlement or token compatibility.

## Account ownership and delivery

Separate three facts in preparation code:

- The service and login owner: `openai` / `openai-chatgpt`.
- The canonical account root: the existing Codex root for the selected route ID.
- The consumer and destination: OpenCode's session or isolated task home.

Add one small account-delivery resolver/helper shared by foreground and
background paths. Its input includes the captured route ID, login integration,
consumer harness, and destination. It returns a validated delivery descriptor;
it must not pick an account itself. Existing route selection remains the owner
of that decision. Do not re-key all credential stores or all login machinery.

For OpenCode, write `<XDG_DATA_HOME>/opencode/auth.json` when
`XDG_DATA_HOME` is set. With it unset, the default is
`<HOME>/.local/share/opencode/auth.json`. Do not append `.local/share` to an
XDG override. Managed spawns will always set an explicit XDG data root, as
described below. The selected `openai` entry contains:

- `type: oauth`;
- `access`: the source access token;
- `expires`: its real JWT expiry, in epoch milliseconds;
- `accountId`: the validated source ChatGPT account ID;
- `refresh`: an empty value only if required by the pinned schema.

The exact minimal schema is a probe result, not an assumption. The pinned schema declares `refresh` as a string with no non-empty constraint
([auth source](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/auth/index.ts)).
Use an empty string in the candidate fixture. No fabricated expiry and no real
refresh token. Reject missing identity, expired access,
unparseable expiry, source/route identity mismatch, or a disconnected account.
An empty refresh value does not disable upstream refresh: on expiry the native
loader can try a token exchange, which must fail and enter bounded recovery.
Test and classify that exact error without exposing token content.

Write an auth file with only the selected OpenAI projection; do not preserve
unrelated provider credentials in this managed file. Remove the projection
when switching this consumer to a string route.

Write atomically with the existing credential ownership and permissions. Use
the session's recorded route to guard every update. Never let a delayed write
for A replace B's projection. Persist enough provenance to identify service,
route ID, consumer, and destination after restart. Reuse existing account and
spawn-home markers where their fields suffice; extend them only where source
owner and consumer can no longer be represented separately.

This projection is disposable. Do not add it to generic refresh-token
publish-back as if it were authoritative. Codex token write-back continues to
use its current source guards. No `.codex` directory is mounted into an
OpenCode session. No new account or quota row is created.

## Managed data directory

The default OpenCode directory is also used by a raw CLI in the terminal.
A terminal login can replace the same auth file with a real refresh token.
Therefore the managed projection must not share that default auth file.

Use a persistent, session-scoped XDG root such as
`/credentials/opencode-managed-data` for all ShipIt OpenCode turns and
compaction in that session. The CLI then reads
`/credentials/opencode-managed-data/opencode/auth.json`. This is a path
inside the session credential mount, not the global credential volume.
Use the corresponding managed directory under the resolved home in local
mode. Reviews and naming get their existing isolated task data roots, with
`opencode/auth.json` directly below each root. Never give a task its account's
canonical root as a writable XDG data directory.

Keep the same managed data root across subscription/key route changes, so
resume does not depend on billing mode. Before the first managed spawn of an
existing session, migrate its conversation state once from the old default
root. Do this at idle admission, before any managed OpenCode process starts.
Use a consistent SQLite backup for the database, not independent copies of a
live database and its WAL. Copy required non-secret session state according
to the pinned CLI's storage layout, omit auth and provider credentials, and
record completion only after the destination is complete. Leave the source
intact on failure and refuse the managed spawn; do not silently start an empty
conversation. Fresh sessions need no migration. A terminal's later login or
work uses its separate default directory and cannot clobber managed auth.

The exact migration state allowlist is established by the pinned storage
probe and a resume test. Update credential provisioning/cleanup declarations
for this managed root, including scoped task homes. This is one local state
migration, not a provider-account storage migration.

## Freshness, concurrency, and cleanup

At admission, resolve the source from the login owner, call a new awaited OpenAI freshness adapter for the captured account, then
read and validate the source again. The existing `ensureAgentTokenFresh`
dispatcher has no Codex hook; it currently returns success without work. Add
the adapter over `CodexOAuthRefresher.refreshNow(accountId)`, reuse its
per-account in-flight promise, and determine success from the resulting
source token, not only the reported outcome. Pass the login owner and captured
account ID into this call explicitly; dispatching the current session's
`agentId` would call the absent OpenCode hook. A healthy source takes a cheap
expiry check first. Forced recovery must attempt renewal and must not treat
an unchanged rejected token as healed. Extend the Codex refresher's force
path accordingly: its current near-expiry check can skip the tier-two call
for a rejected token whose expiry is still in the future. A timeout may permit use of an access token that is still valid;
it must not permit an expired or invalid projection. Fail before spawn when
there is no usable token. Apply this explicit check in local mode too. Separate on-demand refresh
from scheduled refresh: keep timers disabled in local mode, but allow the
account-scoped CLI refresh operation there when its login dependency exists.
Today `refreshNow` also returns immediately outside container mode; changing
that guard is part of the implementation, not an inherited guarantee.

Extend the existing source-update/repush flow to regenerate projections for
OpenCode consumers of that account. Cover scheduled refresh, successful login,
and accepted Codex session token write-back. Use the current source at write
time, not an earlier callback's token bytes. Re-check route provenance and
account existence immediately before the atomic write. Foreground session
homes and active isolated task homes both need this update. Use existing
spawn-home provenance to find consumers; no second background scheduler.

The runtime probe must show that a long-running CLI reads the new projection
on its next request. In-flight requests can finish using the old access token.
If refresh or delivery falls behind and the token expires, stop the request,
refresh the source, rebuild the projection, and use the existing bounded auth
recovery path. Do not replay the whole user prompt blindly after tool effects;
resume the same OpenCode session under the existing retry rules. An uncertain
resume or a second failure ends the turn with the existing persisted error.

OpenCode cannot rotate the shared refresh token because it never receives it.
This does not claim to fix pre-existing concurrency between Codex CLI copies
and the Codex refresher. Those retain their current protections and limits.

Account switch, failover, disconnect, and scoped-task cleanup remove only the
projection and its provenance. Preserve `opencode.db`, sidecar files, logs,
and resume state. Disconnect invalidates delivery first, then removes copies;
a delayed source update cannot restore them. Apply the existing policy for
active processes on explicit disconnect, and test it for this consumer. A
remote request already accepted before disconnect cannot be recalled.

After orchestrator restart, recover consumer destinations from existing
session/spawn-home metadata and rebuild projections before admitting work.
No periodic process started inside a session container is part of this design.

The existing renewal operation first calls `codex login status` (30-second
ceiling), then can call `codex exec --skip-git-repo-check ok` (60-second
ceiling). The second call is real inference and can consume subscription
quota. Reuse these bounds and backoff; do not call it on every request. Record
renewal attempts as refresh activity, and retain their existing usage limits.
The design does not promise free renewal or introduce a direct OAuth exchange
implementation. The Codex binary remains a login/renewal dependency.

## Routing and catalogue

Introduce an explicit account route descriptor for OpenCode; do not use
`serviceRouting === undefined` as its signal. Current `ServiceRouting` is
string-credential shaped. Extend the prepared spawn data with a discriminated
account delivery case, containing non-secret route identity and provider mode.
Keep existing string routing intact. Audit consumers of the new union instead
of adding optional fields whose absence means success.

For the OpenAI subscription case:

- Clear `OPENCODE_DISABLE_DEFAULT_PLUGINS` only for this route. The pinned
  flag disables the entire internal list; it cannot enable only OpenAI.
  Set the effective provider allowlist to OpenAI only. Build an environment
  without unrelated provider credentials and remove conflicting auth/config
  overrides, retaining required process and MCP settings. Pin the effective
  OpenAI SDK and endpoint configuration after project configuration merges.
  Verify that other registered native components make no provider calls or
  credential discoveries for this spawn. If provider filtering does not
  contain their startup behavior, keep the route disabled and revise the
  integration; do not globally enable native auth for existing string routes.
  The probe must use the real adapter flags, not a standalone default CLI.

- Select `openai/<catalogueModelId>` and activate native OpenAI auth.
- Pin the selected provider, SDK, model metadata, and effective Responses path.
  A project base URL, API key, provider override, or ambient auth variable must
  not redirect the subscription bearer. Preserve unrelated project settings. Set internal auxiliary model choices
  (including `small_model`) to the same verified subscription route so title
  or summary calls cannot select another provider.
- Clear conflicting provider credentials and `OPENCODE_AUTH_CONTENT`; use the
  effective XDG auth file, not an environment snapshot that cannot be updated.
- Preserve existing instructions, MCP settings, reasoning variants, and resume.
- Keep remote model fetching disabled. Supply explicit models that the pinned
  native provider accepts, and verify its effective image/context/reasoning
  metadata after its OAuth transformations.

Add Responses capability and the account target only with tests for their
full eligibility effect. Adding a style can expose API-key combinations too;
keep those unavailable until the existing string shaper supports and verifies
them. Add an optional style allowlist to credential delivery targets and
intersect it during eligibility and spawn resolution. OpenCode's string target
allows its current Chat Completions and Messages styles; its account target
allows Responses only. An absent allowlist preserves existing behavior for
other harnesses. This prevents a new account capability from exposing
unsupported Responses-only key routes. Keep OpenCode's native service
as Zen; it is not the owner of this login.

The pinned native filter rejects `gpt-5.3-codex` and `gpt-5.2`.
`gpt-6-astra` is absent from the embedded registry and does not match the
filter's numeric dotted-version rule. Exclude these combinations at launch;
do not assume an explicit model entry bypasses the filter. Add a narrow
optional per-model harness eligibility restriction in the catalogue if the
current model representation cannot state this intersection. Apply it to
picker, admission, and background selection together. A missing restriction
preserves existing eligibility. For GPT-5.5/5.6 variants, native auth can set
400,000 context / 272,000 input / 128,000 output; verify actual compaction and
publish the effective harness-specific window with the existing `byHarness`
metadata rather than copying Codex's display value. Any later CLI change must
re-run these contract fixtures.

Then extend the ChatGPT credential carrier list from Codex to Codex/OpenCode.
Login completion and disconnect must refresh both harness projections. Test
installs that enable only OpenCode: the existing Codex login/refresh dependency
must be available independently of whether Codex is offered as a harness. If
that dependency is absent, show an explicit unavailable reason; do not offer a
connection that cannot finish.

## Recovery, quota, and usage

Resolve auth recovery from the captured account route's login integration.
Add a narrow OpenAI-account consumer mapping rather than making all non-native
services eligible for vendor recovery. Keep Anthropic-key, Zen, Go, and other
OpenCode string routes on their existing policies.

Preserve structured OpenCode errors through the adapter: distinguish expired
projection/auth rejection, quota refusal, missing model, and network failure.
A network failure must not mark the account revoked. A missing model must not
start a login flow. An expired projection triggers at most the existing auth
retry budget, not another retry layer in the adapter. Pin the emitted SDK error
shape and the upstream empty-refresh failure in a CLI contract test, run on
each dependency update. A freshness margin reduces expiry failures but cannot
guarantee a long process never reaches expiry. Do not impose an arbitrary
maximum turn length to make that claim. Native auth must be present and valid
before the provider loader runs: late file creation cannot repair a loader
that already chose the unauthenticated path. After malformed/absent initial
auth, recovery prepares a valid file and respawns the CLI.

Use the existing `openai-chatgpt-usage` provider and the same account route ID
for both tools. Recovery, cutoffs, and quota failover operate on that shared
record. Record actual token counts where supplied. Native OpenCode reports
zero model cost for OAuth; that must not become “unlimited” or an API bill.
Any estimated value remains explicitly an estimate under current usage rules.

## All execution paths

| Path | Required change |
|---|---|
| Foreground and queued turns | Capture route; prepare projection before spawn; use explicit account route. |
| Resume and account failover | Preserve OpenCode session ID and database; replace only account projection. |
| Compaction | Prepare the same route for the temporary `opencode serve` process. |
| Brokered review/consultation | Project into its isolated spawn home and register it for source updates. |
| Naming and PR text | Respect their effective HOME/XDG overrides; project into the actual task data directory. |
| Local runtime | Use the same projection helper; no assumed timer or container mount. |
| Restart/disconnect | Rebuild or revoke using persisted provenance; no stale callback resurrection. |

## Key files and validation

All paths below are under `src/server/`.

| Area | Existing files to change or test |
|---|---|
| Catalogue and route types | `shared/catalogue/{types,harnesses,services,index}.ts`, `shared/types/agent-types.ts`, `orchestrator/service-routing.ts` |
| Delivery and provenance | `orchestrator/session-agent-env.ts`, `session-agent-credentials.ts`, `session-credentials-scaffold.ts`, proposed `openai-account-delivery.ts` |
| Refresh and revocation | `orchestrator/token-sync-manager.ts`, `bootstrap-managers.ts`, `provider-account-manager.ts`, `agents/codex/oauth-refresher.ts` |
| Spawn and errors | `shared/opencode-spawn-shaping.ts`, `shared/opencode-stream.ts`, `session/agents/opencode/{adapter,compaction}.ts` |
| Recovery | `orchestrator/credential-failure-policy.ts`, `ws-handlers/agent-listeners.ts`, turn execution/auth retry callers |
| Background work | `orchestrator/session-namer.ts`, isolated spawn-home preparation and cleanup callers |
| UI projections | Existing Settings login completion, account status, and model selector projections; tests must prove both harnesses update. |
| Agent reference | `shipit-docs/environment.md`, and any auth/config documentation whose statements change. |

The first implementation step is a local fake-endpoint probe of the pinned
CLI with the real ShipIt environment, default-auth flag, and configuration
merge order: fresh token, expired access with no refresh token, atomic token replacement
between requests, provider overrides, model filtering, images, reasoning,
resume, and compaction. Record only synthetic fixtures and sanitized results.
An authenticated smoke test must later confirm an entitled model and real
quota attribution before release. Do not run a second raw CLI with credentials
from a differently pinned session; use the sanctioned test environment.

Co-located tests cover projection schema and permissions, identity mismatch,
malformed expiry, A-to-B races, disconnect during refresh, restart discovery,
isolated task updates, preservation of the OpenCode database, and no publish-back.
Integration tests cover shared quota, login fan-out, exact subscription route,
bounded auth recovery, network/model errors, and no API-key fallback. Include
existing Codex and OpenCode key routes as negative regression cases.

Run affected tests, `npm run lint:dev`, and `npm run typecheck` for the eventual
code change. This documentation-only design does not claim those code gates
have passed.

## Independent review resolution

The independent reviewer checked source and the pinned binary. The design
now addresses disabled native auth, correct XDG paths, terminal-file races,
model exclusions and context limits, explicit login-owner dispatch, and the
quota cost of renewal. Credential-specific style narrowing was added during
review and is specified above. Existing environment scrubbing already removes
`OPENCODE_AUTH_CONTENT`; keep and test that behavior instead of reimplementing it.
The review also confirmed the per-fetch auth read, empty-refresh schema, and
missing Codex freshness hook. Runtime checks remain implementation gates.

## Alternatives and scope control

The review proposed the smallest alternative: use the existing custom
Responses provider with the subscription access token in its API-key field,
a ChatGPT account header, and the Codex backend URL. Billing can correctly
remain subscription even with string delivery. This avoids native auth and
file projection for a short run, but the environment/config token is fixed
for that process. It cannot consume a renewed token during a long turn without
a new request-time credential mechanism or repeated process interruption.
That fails the proposed long-turn requirement and would move complexity into
request handling. It also needs backend request-body and residency handling
validated; the native auth path already owns provider-specific behavior.
Therefore retain live file projection. If the scope were reduced to bounded
short tasks, this alternative would be worth testing first.

A second OpenCode login would duplicate account handling and would not meet the
proposed reuse experience. Copying the full Codex token bundle is shorter but
adds an independent rotating-token writer. A shared writable auth file has the
same problem, plus incompatible file formats. A new inference proxy or custom
OAuth protocol implementation adds unnecessary ownership of provider behavior.

The access-only projection reuses native request behavior and existing source
refresh. It adds one conversion path, consumer fan-out, and an isolated managed data
root with a one-time conversation-state migration. Each exists for an observed
constraint: cross-format auth, long-turn renewal, and terminal auth writes. If the runtime gate
fails, reconsider the mechanism explicitly; neither a proxy nor a new login
system is automatically authorized by this plan.
