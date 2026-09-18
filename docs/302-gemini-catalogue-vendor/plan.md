---
issue: planning#544
title: Gemini API as a catalogue vendor — design
description: How Google's Gemini API lands in the docs/252 catalogue as a vendor row with its own wire format, ahead of any harness that speaks it.
---

# 302 — Gemini API as a catalogue vendor

Implements [requirements.md](./requirements.md). Remaining work:
[checklist.md](./checklist.md).

Key files: `src/server/shared/catalogue/types.ts` (the style),
`catalogue/services.ts` (the row and its prices), `catalogue/model-identity.ts`
and `catalogue/model-vision.ts` (the two new identities), `catalogue/catalogue.test.ts`
(the harnessless-vendor guard), `docker-compose.yml` (the dogfood secret),
`orchestrator/egress-allowlist.ts` + `egress-firewall.ts` (the endpoint host),
`client/components/ServiceLogo.tsx` (the mark), `shared/spawn-routing.ts` (the
OpenCode scrub).

## The wire format (req 4)

`ApiStyle` gains `"gemini-generate-content"`. The name follows the existing
`<vendor>-<api>` pattern (`anthropic-messages`, `openai-responses`): Google's API
is the `generateContent` family, requested as
`POST <base>/v1beta/models/<id>:streamGenerateContent`
(docs/272-opencode-inference § 3 recorded the path when it found Gemini models
unrepresentable without a fourth style).

The mode's endpoint is the bare host, `https://generativelanguage.googleapis.com`,
with no `/v1beta`. That is the shape the spawning brief named and the one the
candidate harness's own override variable takes
(`GOOGLE_GEMINI_BASE_URL`, docs/266-harness-integration-recipe/candidates.md —
vendor-documented, unprobed). Whether the harness appends `/v1beta` itself is the
harness's question, answered when its adapter is written, the same way Claude
Code's `/v1/messages` and Codex's `/responses` conventions are recorded on their
`HarnessDef` rows rather than in the service endpoints.

Every `switch`/`Record` over `ApiStyle` was checked: `wireApiForStyle`
(`spawn-routing.ts`) and `npmPackageForStyle` (`opencode-spawn-shaping.ts`) both
fall through to `undefined` for a style they do not carry, so a Gemini routing
would shape nothing rather than mis-shape — and no routing can be produced,
because no harness resolves the style (below). `ServiceRouting.style` is the
type itself and needs nothing.

## The row (reqs 1–3)

One `ServiceDef`, `{ id: "google", name: "Gemini (Google)" }`, with a single
`key` mode: `credentials: [{ via: "string", storageEnv: "GEMINI_API_KEY" }]`,
no `targetOverride` and no `carriers` (there is no harness to restrict), and
`retired: []`.

- **Service id `google`, not `gemini`.** Service ids are vendors (`anthropic`,
  `openai`, `xai`, `deepseek`); the gateways already namespace the models as
  `google/gemini-…`; and the product name is where the row's display name
  carries it, on the GLM precedent (`"GLM (Z.ai)"`).
- **`GEMINI_API_KEY` is the vendor's own variable name**, the docs/252 req 20
  convention (DeepSeek, xAI): a deployment exporting the documented name has it
  adopted at boot. It is also the variable the candidate harness reads
  (candidates.md, probed), and the one the OpenCode CLI auto-detects for its
  built-in Google provider — which is why `HARNESS_CREDENTIAL_VARS.opencode`
  now scrubs it beside `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY`: a stored
  key lands in the worker's `process.env` and every adapter copies the whole
  environment into its child (docs/252-custom-models/catalogue.md,
  "Credentials belong to the billing mode"), so without the scrub an OpenCode
  spawn would register a live metered Google provider ShipIt never routed to.
- **Models: the current flagship pair**, `gemini-3.8-flash` ("Gemini 3.8
  Flash") and `gemini-3.1-pro-preview` ("Gemini 3.1 Pro (preview)"). The
  subset rule is docs/272's frontier coding set. Google's model list on
  2026-09-13 also carries 3.7 Flash and 3.6 Flash at the same introductory
  price as 3.8 Flash; a row that costs the same and does less was left out,
  and the gateway rows already carry 3.7 Flash for anyone who wants it. Both
  ids are the vendor's own: Google's model pages are keyed by model code
  (`/gemini-api/docs/models/gemini-3.8-flash`,
  `/models/gemini-3.1-pro-preview`), and the candidate harness's `agy models`
  output names the same two lines (`gemini-3.8-flash-*`, `gemini-3.1-pro-*`,
  candidates.md, probed). The Pro id keeps its `-preview` suffix in the
  canonical key: a GA `gemini-3.1-pro` would be a new row with its own
  measurements, not a spelling of this one.
- **Context window** 1,048,576 — Google's published input limit for both
  models (their model pages, read by the independent review below). The
  gateway Gemini rows keep `ONE_M`; a gateway's window is its own figure. The
  first cut copied `ONE_M` here too and the review caught it.
- **Vision** `"yes"` for both: Google describes the line as natively multimodal
  with image input. Recorded as a documentation verdict, not a measurement —
  `MODEL_VISION`'s header already says gateway agreement proves nothing about
  transport, and here there is no transport yet.
- **No `reasoningEfforts`.** The field's contract is "values must come from the
  harness" (`types.ts`), and the harness vocabulary that would validate them
  does not exist yet. Google publishes `low|medium|high` thinking levels for
  3.8 Flash and `low|high` for 3.1 Pro; the harness row that lands the style
  declares them, and the per-model narrowing is one edit then.

### Prices, and the two decisions inside them

`GEMINI_PRICES` in `services.ts`:

| Row | input | output | cacheRead | cacheWrite |
|---|---|---|---|---|
| `gemini-3.8-flash` | 0.75 | 3.75 | 0.075 | 0 |
| `gemini-3.1-pro-preview` | 2 | 12 | 0.2 | 0 |

- **Introductory, not standard.** Google bills the Flash line at an
  introductory rate through 2026-12-31 and doubles it (1.50 / 7.50) from
  2027-01-01. The catalogue records the rate a turn is billed at *today*; the
  switch date is a calendar fact, so it is stated in the constant's comment
  rather than pre-empted. (DeepSeek's peak-rate choice is the other shape —
  there the variation is by time of day and unknowable per turn.)
- **The ≤200K tier for Pro.** Above 200K prompt tokens Pro doubles input and
  charges 18 for output; the xAI row set the precedent of recording the base
  tier and naming the doubled one in the comment.
- **`cacheWrite: 0`.** Google charges no per-token fee to write a cache;
  explicit caches bill *storage* per million tokens per hour, and implicit
  caching (on by default for the Gemini 2.5+ line) writes for free. ShipIt
  records a token count for cache creation, not a duration, so the hourly rate
  has nothing to multiply — and the `ModelPrice` docstring reserves zero for
  exactly "free writes". The OpenRouter Gemini row's non-zero `cacheWrite` is
  OpenRouter's own published figure, copied verbatim there for the same reason
  it is not copied here.

### Provenance — read this before trusting the table

The session container that authored this row could not resolve `ai.google.dev`
or `generativelanguage.googleapis.com` (default egress allowlist; both hosts
answered `Could not resolve host` on 2026-09-13). The figures were authored
from two sources short of a first-hand page read, then confirmed by a third
that had one:

1. **Google's pricing page via web search** (server-side, not container egress):
   five independent reads of `ai.google.dev/gemini-api/docs/pricing` agreed on
   the input/output rates above, the 2026-12-31 introductory window, the
   2027-01-01 standard rates, and the Pro >200K tier (4 / 18). The same reads
   *disagreed* with each other on the cache-read figures, so those were not
   taken from search.
2. **models.dev's source on GitHub** (`sst/models.dev`, `providers/google/models/`,
   reachable because `raw.githubusercontent.com` is on the allowlist), which
   cites the same Google pricing page as its source: `cache_read` 0.075 for
   3.8 Flash and 0.20 for 3.1 Pro Preview (with 0.40 on the >200K tier), and
   input/output equal to the search reads. Both cache figures are 10% of the
   input rate, which is Google's standing cached-input ratio across the 2.5
   and 3 lines — consistent, not proof.

3. **The independent review read the pages first-hand** (`shipit agent run
   --role reviewer`, run `26316b2f`, Codex, 2026-09-13 — its tools could
   reach `ai.google.dev`). It confirmed both model ids, image input, and the
   token prices in the table above against Google's pricing and model pages,
   and corrected one figure: both models publish a **1,048,576**-token input
   limit, where the first cut had copied the gateway rows' `ONE_M`.

So every cell of the table has now been read off Google's own pages by one
agent, though not by the one that typed it. That is the receipt the checklist
item asked for; what remains 🔍 in `catalogue.md`'s sense is only what no
harness can yet measure — that a turn on these rows transports images and
bills at these rates.

## A service no harness carries (req 5)

The brief asked whether anything rejects or mis-renders a service no harness
can drive. Checked at source, nothing does, so nothing was raised with the user:

- **The catalogue join is existential over harness styles.** `resolveStyle`
  finds no overlap for any shipped harness, so `catalogueEntriesForHarness`
  omits every Gemini row, `harnessServiceSupport(h, "google")` is `"none"`
  for all four, and `resolveSpawnShaping` is `undefined` — no picker ever
  offers the rows and no spawn can be shaped onto them. Every invariant loop
  in `catalogue.test.ts` that asserts style/endpoint/effort facts iterates the
  join, so an unjoined row is skipped rather than failed; the row-level
  invariants (real price, real window, endpoint per declared style, identity
  declared and used) all hold.
- **Settings → Model providers already has copy for this shape.** The
  add-service table draws a per-harness support cell from the same
  `harnessServiceSupport` and ends with "A provider no column ticks has no
  harness here to drive it" (`ServicesPanel.tsx`). The Supported-models dialog
  lists every service in the catalogue by design, configured or not, and its
  cells answer per harness. Storing the key is the ordinary string-credential
  flow; the picker shows nothing for it afterwards, which is the requirement.
  Seen in the dogfood instance on 2026-09-13: the add-provider dialog lists
  "Gemini (Google) · API key" with its mark, draws a dash under all four
  harnesses ("Claude Code cannot run Gemini (Google)" and so on), and the
  footnote copy explains the empty row.
- **Two things a new endpoint host DOES have to satisfy**, both guard-tested:
  the host must be in the egress default, lifeline and Tier-A lists
  (`egress-allowlist.test.ts` walks every catalogue endpoint) and the
  `storageEnv` must be in the `dev` compose secrets
  (`seed-inner-credentials.test.ts`). Both done.
- **The service mark is compiler-forced** (`Record<ServiceId, string>`); the
  Gemini glyph is Simple Icons' `googlegemini`, monochrome like the rest.
- **New guard** (`catalogue.test.ts`, "a vendor no harness speaks yet"): pins
  the intended state so the day a harness declares the style is a visible
  change — the rows join no harness, the key resolves to `google/key`, and
  every Gemini model declares only the Gemini style.

## Dogfood (req 6)

`GEMINI_API_KEY` joins the `dev` service's `x-shipit-secrets` (no `agent: true`:
the key is for the inner orchestrator's credential store, not the agent's
environment). The `onboarding` block is unchanged — its exact membership is
asserted because an injected key is adopted at boot and stamps the instance as
onboarded (docs/257).

## Scope held (req 7)

Not done, on purpose: no `HarnessDef`, no adapter, no `LoginIntegrationId`
(Google's OAuth is the harness's account path and belongs to its integration),
no pair verification (nothing to measure a pair with), no client feature. The
client changes are the two the row forces on its own: the mark and whatever the
generic surfaces render from `allServices()`.

## What lands next

The Antigravity CLI harness (candidates.md) declares
`styles: ["gemini-generate-content"]` and a string credential target for
`GEMINI_API_KEY`; the moment it does, the join offers these two rows, the
docs/252 pair verification applies, `reasoningEfforts` can be narrowed per
model, and the "vendor no harness speaks yet" guard is rewritten into the
harness's own join assertions. If a Gemini 3.1 Pro GA id or a newer Flash
appears first, it is a new row with a `RetiredModel` record for the old id.
