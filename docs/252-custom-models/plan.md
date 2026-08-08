---
issue: planning#321
title: Custom models
description: Separate harness from service so a user can run any configured service's models on any compatible harness.
---

# 252 — Custom models

Implements [`requirements.md`](./requirements.md), which has no open questions.

**Visual reference — the picker:** [`mockup-picker.html`](./mockup-picker.html) — an
**interactive** prototype of the two-selector composer (harness, then model). Change the
credentials, the installed harness set and whether the session has taken a turn, and the
selectors react. It is the artifact for the picker decision below; open it and drive it
rather than reading the description.

**Visual reference — Settings → Services:** [`mockup-services.html`](./mockup-services.html)
— **interactive**. You start empty, press *Add service*, and pick service → billing mode →
credential. There is no "Available" block: the catalogue lives in the dialog. One card per
`(service, billing mode)`, matching what the picker groups on, and a subscription card holds
its accounts, their order and the routing settings.

**Visual reference — usage and cost:** [`mockup-usage.html`](./mockup-usage.html) — the usage
view split by service × billing mode, at session and global scope. Three states: a mixed
session, a session that cost nothing, and all-sessions with a weekly chart.

**Visual reference — Settings → Harnesses:** [`mockup-harnesses.html`](./mockup-harnesses.html)
— the derived service×style join, and the background-work setting. Static; the one screen
where API styles are shown, because explaining the join is its whole purpose.

## The idea

ShipIt integrates **harnesses**, not models. `AgentProcess` spawns a CLI and
normalizes its event stream; the model is a `--model` argument that CLI forwards to
an API. So running a different vendor's model does not need a new backend — it needs
the same CLI pointed at a different endpoint (req 1).

That is the whole mechanism, and it is why this is cheap. Everything expensive in an
agent integration — the tool map, the event parsing, skills disclosure, MCP config,
steering, permission modes, plan mode — belongs to the harness and is untouched.

Untouched is not the same as guaranteed. Req 1 is **best-effort**: ShipIt adds no
limitation of its own, and it cannot fix a harness or model either. This is worth
knowing when triaging — a model that calls tools badly, ignores a plan-mode
instruction, or produces weaker diffs is behaving as that model behaves. It is not a
ShipIt defect and should not be filed or designed against as one. What *would* be a
ShipIt defect is a capability the harness and model both support failing to reach
them.

## The actual problem: `AgentId` conflates harness and service

`AgentId` (`"claude" | "codex"`) is used as three different things at once:

- **which CLI binary to spawn** — `AGENT_DEFS[].binary`, `createWorkerAgent()`
- **which credential authenticates it** — `providerAccountManager`, the auth managers
- **which models are offered** — `AGENT_DEFS[].capabilities.models`

A custom model keeps the first, replaces the second, and extends the third. There is
no way to say that today, and every awkwardness recorded in Appendix A is a symptom of
that single gap. Resolving it is the real work; DeepSeek is just the first case that forces it.

**The split the requirements settle on is three-way, not two-way** (reqs 5–6):

| Concept | Is | Identified by |
|---|---|---|
| **Harness** | a CLI to spawn, speaking exactly one API style | `claude`, `codex` |
| **Service** | a catalogue entry: endpoints, API styles, and the models declared for each | a `serviceId` such as `openrouter` |
| **Model** | a model id a service offers | the pair (serviceId, model id) |

A service is *not* the credential. One service holds zero or more user-supplied
credential routes — see the ownership table under Design, which req 12's "another
subscription of the same service" depends on.

A model id alone is **not** a global identifier: the same model is reachable through
DeepSeek directly and through a gateway like OpenRouter, at different prices and
possibly different API styles. Whatever the picker persists must therefore carry the
service identity, or "the selected model's service" cannot be resolved and req 11
cannot say which service billed a turn. This is a change from the spike, which keyed
everything off a bare model id.

Compatibility is **partly derived, partly declared** (req 6). Speaking a style is
necessary but not sufficient: a service also declares *which of its models* work under
each style it speaks. A model is offered on a harness when the service speaks that
harness's style and lists that model for it.

The declaration is not bureaucracy — it is the only honest way to express reality.
DeepSeek speaks both styles yet supports only `deepseek-v4-flash` under Codex, and
Codex additionally wants per-model metadata (context window, tool format, reasoning
settings) beyond a bare id. A purely derived rule would list `deepseek-v4-pro` under
Codex and let the turn fail. Nothing forbids that at runtime — req 8 is only about
credentials — so the catalogue is where it has to be prevented, by not listing the pair
in the first place (req 6).

A consequence worth noting, though not a requirement of its own: a harness added later
picks up every configured service that speaks its style, limited to the models already
declared for it. Nothing has to enumerate harness×service pairs by hand. This used to be
stated as a separate requirement; it was deleted as derivable from the offering rule
above.

This is also why "should we support OpenAI-compatible providers?" was the wrong
question. It is not a scope boundary; it is a property of each service, and it decides
which harnesses that service appears under rather than whether it is supported at all.

## Phases

Nine phases, each intended to be **one pull request**: independently reviewable, green on
its own, and leaving the product in a coherent state. They are ordered by dependency —
phase 1 is the refactor everything else needs, and the feature first works end to end at
phase 3.

Requirement numbers refer to [`requirements.md`](./requirements.md). The per-area detail
for each phase is in **Design** below; this table is the sequencing, not a second copy of
the design.

| # | Phase | Reqs | Lands |
|---|---|---|---|
| 1 | Catalogue and identities | 5, 6, 7, 15 | The data model, with its launch rows. No user-visible change. |
| 2 | Credentials and Settings | 5, 7 | You can save a service key. It does nothing yet. |
| 3 | Spawn shaping and eligibility | 1, 2, 3, 8 | **A session runs on a custom service.** |
| 4 | In-session switching | 4 | Switching models, including across services. |
| 5 | Credential-failure policy | 12 | Correct behaviour when a credential dies. |
| 6 | Usage and attribution | 10, 11 | You can see what you are running and what it costs you. |
| 7 | Non-turn work | 9 | Naming and PR descriptions get their own model. |
| 8 | Model retirement | 13 | Sessions survive a model leaving the catalogue. |
| 9 | Harness install selection | 14 | Deployments choose their harnesses. |

**Phase 1 — Catalogue and identities.** The service catalogue as data: `serviceId`, the
API styles each service speaks, per style the models declared for it plus the metadata
that style needs, and a per-style endpoint. `AgentId` gains a declared API style and stops
meaning anything else. The selected model becomes the pair `(serviceId, modelId)`
throughout — types, persistence, and the picker's plumbing. Anthropic and OpenAI become
ordinary catalogue rows.

It also authors the launch rows req 15 names: Anthropic, OpenAI, DeepSeek, OpenRouter and
Vercel AI Gateway. Only Anthropic and OpenAI are reachable at this point — the rest need
phase 2's credential storage — but they are catalogue data, so they belong to the phase that
introduces the catalogue.

This phase is a refactor with **no behaviour change**: the picker offers exactly the models
it offers today, now derived from the catalogue rather than from `AGENT_DEFS`. That is the
review criterion — if anything user-visible moves, the phase is wrong. It is also the
largest and least glamorous PR, and everything after it is small by comparison.

Authoring a row means establishing, per service, which API styles it actually speaks and
which of its models are declared under each (req 6). For the gateways that is research, not
recall — it must be checked against each gateway's current documentation when the row is
written, not assumed from this doc.

**Phase 2 — Credentials and Settings.** Per-service credential storage, the Settings →
Services screen (see the mockup), a compile-time env-key name per catalogue service, and
closing the compose delivery gap so a stored key reaches a compose-backed containerized
session. Existing subscription-backed vendors keep their current credential path untouched.

Ends with a key you can save, edit and remove, that is delivered to the session container
and used by nothing. Shipping this alone is deliberate: credential storage and delivery is
where the security-relevant review is, and it deserves a PR that isn't also changing how
turns run.

**Phase 3 — Spawn shaping and eligibility.** Both spawn sites set the base URL and
credential from the selected model's service, after the scrub. Eligibility moves from
`hasAnyAuthForProvider(provider)` to the per-model credential question, which is what stops
`claude-*` models being offered on an install whose only credential is a DeepSeek key.

It is also where req 3 becomes observable: the moment a custom model is offered, it is
offered in the one picker alongside everything else, with no separate surface for a
vendor's own models. The composer's picker splits in two here — harness and model as
separate controls, model rows grouped by service — because this is the phase where
harness-as-group-header stops being able to express the list.

**This is the phase where the feature exists.** A fresh session on DeepSeek V4 Flash under
the Claude Code harness takes a turn, with no Anthropic credential anywhere. The spike
already established this works (Appendix B); this is the version that follows the
requirements.

**Phase 4 — In-session switching.** Widen the resident process's identity from a model
string to the whole spawn-relevant tuple — harness, service, API style, endpoint,
credential route, model — so a same-id/different-service switch forces a respawn instead of
silently reusing the old endpoint and credential. Mid-session switching then works across
services, not just within one.

**Phase 5 — Credential-failure policy.** Branch on how the failing service is
authenticated rather than on the error text. Two gates, not one: the auth-error
interception must not drag a key-authenticated service into vendor re-auth, and the
same-turn quota retry needs the same credential-kind gate that account benching already
has. Establish Codex coverage rather than assuming it.

**Phase 6 — Usage and attribution.** Quota reporting moves from `AgentId → routeId` to
per-service, with a service that reports no quota rendering nothing at all. Attribution
surfaces the active model, its service, and whether it bills a key or a subscription — in
the surfaces that already exist, not in new composer chrome (see below). The Settings →
Harnesses screen lands here too, since it is the same join rendered for a different question.

**Phase 7 — Non-turn work.** Session naming and PR descriptions get their own explicitly
chosen `(service, model)`, visible as a setting whose unset state resolves to the first
eligible model rather than to a named one. Includes
normalizing a blank PR generation into the generic fallback — today's code returns the
empty string in containerized production — and the durable, dismissible failure notice.

The largest phase after the first, because it is the one place with no existing seam.

**Phase 8 — Model retirement.** A per-service map from retired model ids to their
successors, resolved where the session's model is read, generalizing the existing
`normalizeCodexModelId` shim. Small, but it is what lets curation happen without stranding
sessions, so it should land before the catalogue is trimmed in anger.

**Phase 9 — Harness install selection.** Which harnesses a deployment installs becomes a
build input, defaulting to Claude Code and Codex. This supersedes the never-implemented
sketch in `docs/154-cursor-agent-adapter`, which proposed the same mechanism
(`INSTALL_*_CLI` booleans written to `/opt/shipit/agents/installed.json`) for the same
reason. Last because nothing else depends on it, and because it is the phase most likely
to be deferred indefinitely without cost.

## Design

Settled by the 2026-08-05 answers. **Every service is ShipIt-defined** (req 5) — there
is no user-authored service, only user-supplied credentials for services ShipIt ships.
This feature adds **key-authenticated** services to that set; a subscription needs its
own login, refresh and account handling, which is per-service ShipIt work, so
subscription-backed services remain the vendors already implemented.

**Data model — two layers, with different owners.**

*ShipIt ships the catalogue* (req 6): which services exist, which API styles each
speaks, and per style, which of its models work there plus any metadata that style needs
(Codex wants context window, tool format and reasoning settings). This must be
a **maintained subset**, not a mirror of everything a service offers (req 6). Only a
handful of models are worth using for coding at any time, so an aggregator advertising
400+ models contributes a short curated list rather than 400 rows.

Per-model metadata — Codex's context window, tool format and reasoning settings — is
simply stated per model, there being few enough of them. The cost is a judgement call
ShipIt owns and revises: which models are worth carrying. A per-style endpoint belongs here too:
one base URL per service is wrong for a service whose styles live at different paths.

*The user supplies credentials* (req 7) for the services they want to use. That is the
whole of what they own; they are not authoring catalogue entries. The consequence is
explicit in req 7 — a service ShipIt does not know about needs a ShipIt change.

**Which is why the catalogue's launch contents are themselves a requirement** (req 15).
With no user-supplied endpoints, an empty-ish catalogue would make the feature true on
paper and useless in practice, so the shipped set is specified: Anthropic and OpenAI
first-party, DeepSeek as the direct key-authenticated case, and OpenRouter and Vercel AI
Gateway as the gateways.

**A gateway needs no mechanism of its own** — that is the whole point of having settled on
the service as the primitive. It is a row with a key that happens to reach many upstream
vendors, and every part of the design already covers it: curation keeps its hundreds of
models to a handful (req 6), the pair identity distinguishes its `deepseek-v4-flash` from
DeepSeek's own, and attribution names it as the service that billed the turn (req 11).
If adding OpenRouter needs anything the design does not already have, that is a signal the
service abstraction is wrong, not that gateways need special handling.

One consequence is worth stating because it reads as a bug and is not: a gateway key can
make a vendor's own models available to a user with no account at that vendor, and — since
gateways commonly speak the OpenAI style — can offer them under a harness that vendor did
not write. Anthropic models under Codex, via OpenRouter, is reqs 2 and 6 working exactly as
specified. The eligibility check must not acquire a "but these are really Anthropic's
models" special case to prevent it.

**User-supplied endpoints are deferred, not designed away** (req 15). Nothing here should
foreclose them: a service row is already `(endpoints, styles, declared models)`, which is
the same shape a user-supplied one would need, so the later feature is a new *source* for
catalogue rows rather than a new concept. Do not add a mechanism for it now.

**Four distinct identities, which an earlier draft blurred into one.** This doc first
called a service "a credential + endpoint" and later a ShipIt-owned catalogue row; those
are different things, and req 12's "another subscription of the same service" only makes
sense once they are separated:

| Thing | Owner | Example |
|---|---|---|
| `serviceId` | ShipIt catalogue | `openrouter` |
| **billing mode** | ShipIt catalogue, per service — `sub` or `key`, each declaring its own models | DeepSeek `sub` vs DeepSeek `key` |
| credential route | the user — one key, or one subscription account, within a mode | a stored key, or `acct_…` |
| selected model | the session | `(serviceId, billingMode, modelId)` |
| turn route | resolved per turn from the credential routes **of that mode** | which key/account this turn used |

One catalogue service can therefore hold several credential routes, which is exactly the
case req 12 fails over between — but only *within* a mode.

**The billing mode is selected; the credential route is not** (req 5). This is the line that
took a wrong turn once, so it is worth stating plainly. An earlier draft had the mode
resolved per turn alongside the route, on the grounds that ShipIt's account manager already
walks subscription accounts before falling back to a metered key. That is how the code
behaves and it is the wrong basis for the decision — the two modes are not interchangeable
the way two subscriptions are:

- **Their model sets can differ.** A plan tier need not include everything the API sells, so
  a merged list offers a model the resolved route cannot serve (req 6).
- **Their prices differ**, which is already the reason this design lists the same model id
  separately per service. Included-versus-metered is that same distinction inside one
  service, so merging them contradicts the rule that justifies the pair.
- **Failover never crosses them** (req 12), so a merged entry leaves a user with a spent
  subscription and an unused key unable to say "charge me, keep working" — the same class of
  dead end req 9 exists to prevent.

Several *subscriptions* to one service still collapse into one mode: req 12 routes between
them and the user never picks among them. So the picker's grouping key is
`(serviceId, billingMode)`, which is at most two groups per service rather than one per
credential.

Anthropic and OpenAI are catalogue rows like any other, not special cases (req 5).
`AgentId` keeps meaning *harness* only, and gains a declared API style.

The picker's list for the active harness is then every `(service, model)` pair the
service declares under that harness's style, filtered to services with a usable
credential (reqs 6, 8). Note the entry is the **pair**, not the model id — the same id
can come from more than one service at different prices.

It stays **one model picker**, listing every eligible model the same way regardless of which
service provides it (req 3). A vendor's own models must not get a separate surface or a
privileged position in this one — that is the same rule as "Anthropic is a catalogue row
like any other", seen from the UI side.

**Two selectors, not one: harness and model separate** ([prototype](./mockup-picker.html)).
Today `ModelAgentSelector` is a single dropdown whose group headers are *harnesses*, because
harness and provider are the same thing. Once they are separated, that grouping is wrong
twice over: the group header is needed for the **service** — which is what the credential,
the price, the billing pill and the usage indicator all hang off — and the harness stops
being a group at all. It becomes an axis that selects *which* list you are looking at.

This does not touch req 3, which is about models: model selection stays one list in one
place. The harness is a different choice with different consequences, and the decisive one
is that **it is not reversible**. Per-agent credential isolation pins the harness for life
at the first turn (`docs/138`), while models stay switchable (req 4). Today that asymmetry is
rendered as greyed rows and a lock badge on a group header *inside* the model menu, so the
single most consequential fact about the session is visible only to someone who opens a
dropdown and reads it. Two controls make it structural: one is disabled with the reason on
it, the other is fully live, and both are legible on the closed composer.

The split has one real cost and one new interaction, both worth deciding deliberately:

- **The other harness's models stop being visible in one list.** The combined picker showed
  everything and greyed what you could not have — worse as a lock affordance, better as a
  map. The obvious patch is a footer on the model menu ("3 more models on Codex"), and it is
  the wrong one: it grows with every installed harness, and it is useless the moment the
  harness is pinned, which is most of a session's life. The answer instead is that the
  **harness menu states each harness's model count on its own row** — the information lands
  on the control that would act on it, and one line per harness in a menu that already lists
  harnesses does not accumulate into clutter.
- **Switching harness can strand the selected model.** Keep the model when the new harness
  also offers that exact `(service, model)` pair — which is why `deepseek-v4-flash` survives
  a Claude Code → Codex switch — and otherwise move to the first eligible model and say so.
  Landing somewhere else silently would contradict req 11; refusing the switch would make an
  enabled control lie. The combined picker never had this case, because there the harness and
  model moved together by construction.

A third case looks new and is not: removing a service's credential mid-session strands the
selection with no successor to move to (req 13's map never crosses services). Req 12 already
answers it — an API key does not fail over, so ShipIt stops and says so. The split only
changes *where* that surfaces, from a failed turn to a picker state you can see before
sending.

**The picker states what you choose on, and nothing else.** Everything the split makes
*expressible* is a candidate for showing, and almost none of it earns composer space. What
survived, and what did not:

- **No labels on the triggers.** A product name and a model id do not need the words
  "harness" and "model" in front of them. The closed composer is
  `Claude Code ▾ | deepseek-v4-flash ▾ High ▾` — three controls, since reasoning
  (docs/217's per-session control) sits beside the model as it does today.
- **The service pill is disclosure-on-demand**, appearing only when that model id is offered
  by more than one eligible group on this harness. That is the sole case where the id alone
  cannot say who is billing you — exactly the case the identity exists for — so it shows up
  when the ambiguity is real and costs nothing otherwise. It names the **billing mode**
  ("Subscription") when the duplicate rows are within one service, and the **service**
  ("OpenRouter") when they cross services, because that is the axis that actually differs.
- **No API style anywhere in the picker.** `anthropic-messages` / `openai-responses` is
  ShipIt's vocabulary for why a join holds; it is not a fact anyone chooses on. Each harness
  row states its **model count** instead, which is the same information in the form the
  decision needs. Styles stay on Settings → Harnesses, whose entire job is explaining why a
  service appears under one harness and not another.
- **No explanatory footers.** Neither "N more models on Codex" nor "installed at deploy time
  — nothing to add here". The first is covered by the harness rows' counts; the second by the
  absence of an add affordance. A menu that has to narrate itself is the wrong menu.

The through-line: this feature adds three new axes (harness, service, API style) and the
temptation is to surface all of them because they are newly nameable. Only the ones a user
acts on belong in the composer; the rest belong in Settings, where explaining the join *is*
the screen's purpose.

**Attribution needs no new surface** (req 11). Once the harness and the service are on the
composer's two triggers, "which model, which service, key or subscription" is already on
screen or one click away: the model trigger carries the model and its service, and the model
menu's group headers carry the billing kind. Req 11 asks that the user *can tell* — not that
it be restated permanently — so a standing "Running *model* via *service* on *harness*" row
under the composer is redundant chrome and was cut from the prototype for exactly that
reason.

What still needs doing is smaller than a new surface: `UsageModal` already shows a **Model**
stat (`UsageModal.tsx`), and that is the established home for "what actually ran" — a
comment in `ModelAgentSelector.tsx` already names it as such, having moved live-model display
there once. Service and billing kind join it there. Attribution is then two places with
distinct jobs: the picker answers *what will run next*, the usage modal answers *what did
run* — which is the same split the selector's precedence rules already maintain between the
persisted selection and the CLI's last-reported model.

**Full separation is the point.** No code path should ask "which vendor's agent is
this?" to decide anything about credentials. Concretely, req 2 means a user with only a
DeepSeek key runs the Claude Code harness with no Anthropic account anywhere in the
system — so `providerAccountManager`'s per-`AgentId` account model has to become a
per-*service* one, not gain a fallback branch.

**The harness set is a deployment property** (req 14). Nothing in Settings adds, defines
or removes a harness, and the Harnesses screen in the mockup is read-only for exactly this
reason. Which harnesses an install *has* is a session-image build input, defaulting to
Claude Code and Codex.

This is not a new mechanism — `docs/154-cursor-agent-adapter` specified it and was never
implemented: `INSTALL_CLAUDE_CLI` / `INSTALL_CODEX_CLI` / `INSTALL_CURSOR_CLI` booleans
consumed by the image build, with the result written to `/opt/shipit/agents/installed.json`
for `AgentRegistry` to detect. Req 14 adopts that design and supersedes the doc; the parts
of docs/154 that remain distinct are the Cursor **adapter** itself and its stream parsing,
which this feature does not touch.

Consequence worth stating because it is easy to get backwards: *installed* and
*credentialed* are different gates. A harness that was not installed offers nothing
regardless of credentials, and a harness that was installed still offers only the models
whose service has a credential (req 8). The picker's filter is the conjunction, and an
uninstalled harness should be absent rather than shown-and-empty.

**Settings → Services is an add-flow, not a catalogue listing.** Two layouts were
prototyped and this one was chosen; the rejected one (a Connected/Available listing of every
service ShipIt knows, with billing modes nested inside each service card) has been deleted
rather than kept, so nothing in this folder still shows it.

The screen is a list of **what you configured**, not of what exists. It starts empty; the
catalogue appears inside the add dialog, at the moment it is a choice. That keeps the screen
proportional to the user's setup rather than to ShipIt's — the rejected layout grew with the
catalogue whether or not any of it was used.

The discoverability cost was weighed and accepted: req 15 makes the shipped catalogue a
promise, and a listing answers "which services does ShipIt support?" at a glance where this
needs a click. The judgement is that someone who needs OpenRouter or Vercel is looking for
it and will find it.

Two things make the add-flow the better fit rather than merely the tidier one:

- **Step 2 asks how you pay for it**, showing "Subscription — 1 model" against "API key —
  2 models". The distinction the picker groups on is one the user makes deliberately, rather
  than discovering later inside a nested card.
- **A card is one `(service, billing mode)`** — exactly the picker's grouping. An earlier
  draft made every credential its own row, so two Anthropic subscriptions were two rows in
  Settings and one group in the picker, with the two surfaces counting differently. Grouping
  by service × mode removes the mismatch rather than explaining it.

**The routing settings are why the card is the group.** Order, *Use in order* vs *Spread
across accounts*, and the failover cutoffs are all answers to "which of these accounts
next?" — a question that only exists where there is a group to choose from. Today they are
per-`AgentId` (`selectionMode`, `isPrimary`, `failoverCutoffs` in `ProviderAccountsCard`);
per `(service, mode)` is that same setting re-keyed, not a new mechanism. Nesting the
accounts and housing the routing settings turned out to be the same fix.

An API-key card therefore has **no routing controls at all** — not a disabled group, not an
empty section, and no sentence explaining the absence. Keys do not fail over (req 12), so
there is nothing to order and nothing to spread. The asymmetry between the two card types is
req 12 rendered.

**Credential failure branches on credential type, not on the error** (req 12). This is
the load-bearing simplification: ShipIt does not classify the failure, it looks at how
the failing service is authenticated — a fact it holds statically in the service row.
A subscription fails over to another subscription *of the same service*; an API key
does not fail over at all, and the turn stops.

Review confirmed this is the right axis and that the existing code already half-draws
it — but found the gate is applied in **one** of the two places that need it. Account
benching checks the route kind and bails for a reserved route
(`bootstrap-managers.ts:442`), while the same-turn quota retry does not: it fires on
`detectHardExhaustion(event.error)` alone (`turn-executor.ts:938`). A key-authenticated
service answering "quota exceeded" would therefore be retried once on the same bad key,
which is exactly what req 12 forbids. Both paths need the credential-kind gate.

That also means there is no service re-prompt flow to build; an earlier draft proposed
one. See Appendix A for what has to be *removed* instead.

The rule generalizes rather than invents. Today `provider-account-manager.ts` already
refuses to mark a reserved API-key route exhausted ("they are metered billing, not a
subscription window", `:642`), treats reserved routes as always usable (`:720`), skips
them when stamping exhaustion (`:800`), and never routes onto pay-as-you-go because a
subscription is unavailable (docs/150 req 12, `:605`). The work is to lift that from
per-`AgentId` accounts to per-service credentials, not to invent a policy.

**Eligibility** (req 8) moves from `hasAnyAuthForProvider(provider)` to a per-model
question: *does the service offering this model have a credential?* With Anthropic as an
ordinary service, "Claude with no account connected" and "DeepSeek with no key" become
the same condition answered by the same code. This retires the spike's overstatement
rather than patching it.

Note the narrow scope: eligibility is a **credential** check and nothing more. It does
not assert the model will work — that is req 1's best-effort territory — so there is no
runtime validation to build and no staleness policy to maintain. A model that stops
working at its service is a catalogue update in the next ShipIt release.

**Reasoning effort stays on the harness, and the catalogue gains no reasoning field.**
Worth stating because it looks like an oversight: `AgentCapabilities.reasoning`
(`agent-registry.ts`) is keyed per `AgentId` — Claude Code's `--effort low…max`, Codex's
`model_reasoning_effort none…xhigh`, each verified against its CLI (docs/217) — and this
feature leaves that alone even though it un-keys models from `AgentId`.

The tempting change is to declare per model whether reasoning is supported, and hide the
control when it is not. It was considered and rejected, for a reason that is easy to miss:
**the harness is not a transparent pipe for the setting.** Even a correct per-model claim
says nothing about whether the harness in use forwards it, so a harness that quietly drops
the flag would leave ShipIt asserting support that does nothing — the same dishonesty,
relocated and made to look more precise. There is also no maintainable source for the fact,
which would put per-model upkeep on the axis req 6 shrank the catalogue to avoid.

So the offered levels are the harness's, unnarrowed, and a value the model does not honour
is req 1's best-effort territory. A value the *harness* rejects is the harness's error to
raise — the authoritative answer, arriving from the component that actually knows, which is
strictly better than a ShipIt-side prediction that pre-disables the control.

**One consequence for the composer, easy to miss because reasoning is not changing:** since
the levels belong to the harness, a harness switch can strand the *effort value* just as it
can strand the model. Claude Code has `max` and Codex does not; Codex has `none` and
`minimal` and Claude Code does not. The rule is the same shape as the model's but the
fallback is different — **reset to Default rather than mapping to a neighbour**, because a
level name shared by two CLIs is not a promise of shared semantics, and Default (omit the
flag) is always valid. A value both harnesses accept survives untouched. A harness with no
reasoning block at all shows no control rather than an empty one.

That makes three things a harness switch can move — model, billing mode, effort — and the
composer has to report all of them in one message rather than the last one to be computed.

**Mid-session model switching** (req 4) is a capability question per harness, not a new
mechanism: the model is already a per-turn spawn argument, and `AgentCapabilities`
already carries per-harness flags. A switch that crosses *services* additionally
re-resolves the credential and base URL for the next spawn.

ShipIt already forces a respawn boundary for a *model* change:
`releaseResidentOnModelChange` (`resident-model-guard.ts`) kills a resident process
whose spawn-time model no longer matches the selection, and the turn respawns with the
new `--model` and `--resume <session>` (`agent-execution.ts:291`).

**But a service change does NOT ride that boundary, and an earlier draft of this doc
wrongly said it did.** The guard compares two model *strings* — `runner.appliedModel`
against the desired model (`resident-model-guard.ts:44`) — and `appliedModel` is set
from `runParams.model` alone (`turn-executor.ts:1225`). Since the same model id can be
offered by two services, switching `deepseek-v4-flash` from DeepSeek direct to
OpenRouter leaves the strings equal, no kill fires, and the next turn runs on the
**old process with the old endpoint and old credential** — silently billing the wrong
service and contradicting req 11.

So req 4 does need a change after all: the resident process's identity must be the
whole spawn-relevant tuple — harness, service, API style, endpoint, credential route,
model — not a model string. This is the same `(service, model id)` identity the picker
needs, applied one layer down; the two should share a representation rather than each
inventing one.

Note the correction this implies for "the model is already a per-turn spawn argument":
for a **resident** process it is not. Later turns are injected without spawning until
that guard forces a boundary, which is precisely why the guard exists.

**Credential delivery** reuses the existing pipe with **one** correction, not two: a
compile-time key name per catalogue service is sufficient (Appendix A). What
does still need building is the compose path — a compose-backed containerized session receives only
compose-declared and `mcp__*` secrets, so a stored service key never reaches it.

**Subscription credentials are out of scope for the services this feature adds**
(req 5), which is what keeps credential delivery to one flow. Subscriptions travel through account
credential roots and filesystem mounts rather than `agentEnv`, and each needs its own
login and refresh — the reason req 5 draws the line where it does. Existing
subscription-backed vendors keep their current path unchanged.

**Spawn shaping** sets the base URL and credential at both spawn sites, after the
scrub, from the *selected model's* service rather than from a model-id prefix.

**Non-turn work** (req 9) — session naming and PR descriptions run on a model the user
chooses **for that purpose**, resolved independently of whatever the session is using.
It is a `(service, model)` selection like any other, not a service alone: a service does
not identify something callable. It surfaces as its own setting, and it has a default so
the feature works unconfigured — the setting being *visible* is what stops that default
from re-creating the hidden dependency this requirement exists to remove.

**The default is a rule, not a stored value** (req 9): unset means *the first eligible
model in the picker's own ordering* — first service, first model — resolved at the point
non-turn work runs, not frozen at install. Eligible is the same conjunction the picker
uses: an installed harness (req 14) whose service has a credential (req 8). So the setting
has two states, and they are not the same thing: **unset** follows the install, and **set**
is a pin the user chose and ShipIt does not move. Only the second can go stale, and it is
the one req 9's notice reports on.

A consequence worth accepting rather than designing around: the picker orders by
capability, so the derived default is likely to be a *large* model doing work — session
titles, PR descriptions — that a small one does fine. Nothing here says otherwise, and
cheapness is not a requirement. If it turns out to matter, the fix is the catalogue's
ordering, not a new "suitable for background work" concept.

The two halves are not symmetric, and an earlier draft wrongly said both merely preserve
today's behavior:

- *Session naming already behaves as required.* `generateSessionName` returns `null` on
  any failure and is documented as silent best-effort (`session-namer.ts:19`);
  graduation installs a placeholder first (`graduate-session.ts:158`) and keeps it when
  naming returns `null` (`graduate-session.ts:311`). Only the notice is new.
- *PR descriptions do not.* `generatePrDescriptionFromContext` returns whatever
  `generateText` returns (`services/github.ts:1412`), and in containerized production
  that is the empty string (`app-di.ts:485`) — the generic prose lives only in the
  `catch`, so it is reached on a thrown error and not on a blank result. Satisfying
  req 9 therefore means **normalizing a blank generation into the generic fallback**,
  with separate tests for the rejection path and the blank-success path.

**The notice has to be durable, not a toast.** Session naming is fire-and-forget: it can
finish while the user is looking at another session or with no viewer attached at all, so
a transient toast would be silent in exactly the case req 9 exists to prevent. It should
be transcript content, which brings it under ShipIt's persistence and session-scoping
rules — persisted via `emitChatCard`, carrying its owning `sessionId`, registered in
`TRANSCRIPT_SCOPED_MESSAGES` (see `docs/188`, `docs/191`). Dismissal is state on that
row, not the absence of one. Deliberately not "follow the session's model": the failure this
requirement comes from was a credential disappearing underneath work that assumed it
(a lapsed Claude subscription while working in Codex), and inheriting the session's
model would leave that same implicit dependency in place, merely pointed elsewhere. An
explicit setting is also the only version that can be *shown* to the user as broken
when its service stops working. This is the one place with no existing seam at all, and
the largest single piece of work here.

**Retiring a catalogue entry** (req 13). Curation means removal is routine, so each
service's catalogue row carries a map from its own retired model ids to their
successors. A session pinned to a retired model resolves through its service's map at
the point the model is read, and runs on the successor; the picker offers only current
models.

The map lives **inside a service and maps model id to model id** — it never crosses
services. That is a requirement (req 13), and it is also what makes the mechanism
trivial: because `serviceId` is unchanged by a remap, the credential, the endpoint, the
API style and the price are all unchanged too, so a remap cannot strand a session on a
service the user has no credential for. Two services retiring the same model id toward
different successors is still handled — each states its own successor in its own row.

There is precedent to copy rather than a mechanism to invent: `normalizeCodexModelId`
(`agent-registry.ts:141`) already does exactly this for one model, mapping the retired
`gpt-5.6` slug onto `gpt-5.6-sol` "at the boundary before Codex turns so legacy sessions
run the intended Sol model". Req 13 generalizes that one-off shim from a hardcoded
per-`AgentId` special case into a per-service catalogue field resolved at the same
boundary.

Because the session now reports the successor, req 11 makes the remap visible rather
than silent — the picker and attribution show what is actually running, not what was
originally chosen.

**Usage** (req 10) is reported per service. The existing types are partway there but
less far than this doc first claimed: the wire shape is **`AgentId` → `routeId` →
limits** (`usage-limits-types.ts:74`), so it is keyed by provider *and* route, and
`LimitsProvider`/`LimitsRegistry` are selected by `AgentId` first
(`agents/types.ts:22`, `limits-registry.ts:39`). An individual snapshot carries a
`routeId` and its comment does say "quota belongs to the subscription, not the
provider" — but that is the inner key only. Moving to services touches the map shape
and the registry, not just `LimitsProvider`.

Note this is two distinct things, and only the first is at issue: **quota telemetry**
(`SubscriptionLimits` — plan tier, rolling and weekly windows, `usedPct`, `resetAt`,
fed by `rate_limit_event` or `/api/oauth/usage`) versus **token and cost accounting**
(`RecordedTurn` — `costUsd`, input/output tokens, cache reads, context occupancy),
which ShipIt already records per turn for every provider. A key-based service has no
quota to report but full token accounting. Req 10 keeps that slot **empty** for such a
service, which is what a key-based route already does today — so this is inherited
behavior to preserve, not new behavior to build. Putting spend in that slot is
deliberately out of scope; the data exists, but it is its own feature.

**Cost is reported per service × billing mode, and a single total stops being honest**
([prototype](./mockup-usage.html)). `UsageModal` shows one **Cost** stat today
(`currentSessionUsage.totalCostUsd`), which is correct while a session has one provider and
one way of paying. Once a session can move between a subscription and a metered key — even
within one service — that total silently adds *money spent* to *tokens already paid for*.

The split is the same axis as everywhere else, and the two DeepSeek rows in the prototype are
why it has to be the **mode** and not the service: one service, two lines, and merging them
would attach a price to a row that is mostly free.

Two headline numbers rather than one, because dollars and quota do not sum: **"You paid"**
totals the metered rows only — the one figure that is money — and plan usage is counted in
turns beside it. A session with no metered rows says **"Nothing"**, not `$0.00`; a zero reads
as telemetry that came back empty, which is the wrong impression for what is the normal case
for a subscription user.

**Plan usage carries its API-rate value too** — "≈ $243.60 at API rates". That is the number
that says whether a subscription is worth keeping, and an earlier draft withheld it to
protect the paid/included distinction. That was overcautious: the distinction is carried by
colour, wording and position, not by the absence of a second figure. It is not the paid
colour, it sits below the volume rather than in the amount slot, it is prefixed `≈` and
suffixed "at API rates", and it is **never** summed into "You paid", which stays the only
figure that is money.

**The weekly chart stays a toggle and does not stack.** `UsageModal` already toggles cost vs
turns; this adds a third option (Paid / At API rates / Turns) rather than stacking a second
series on the first. Two segments in one bar carrying two different units invites reading
them as parts of a whole, which they are not. The split still tells its story across the
toggle — weeks where Paid rises are weeks where At API rates falls, meaning work moved *off*
the plans rather than that there was more of it, which Turns confirms.

**One thing to establish before building it:** what `costUsd` means for a subscription turn
is currently unknown. `usage.ts` records the CLI's figure uniformly, with no notion of
billing mode, so the same stored number may be money spent or a notional API-equivalent
depending on how the turn was authenticated. Both halves of this screen now depend on the
answer — the paid total needs the money reading, the "at API rates" figure needs the notional
one, and if the CLI only ever reports one of them the other has to be computed from token
counts and a price table.

**The known-wrong behaviors** resolve unevenly:

- The **empty usage pill** is not a bug at all once the indicator is per-service — a
  service with no quota should show nothing (req 10).
- The **non-turn failures** are covered by req 9, though as two separate paths rather
  than one.
- The **401 misfire** is fixed by *deleting* behavior, not adding it (req 12). Today
  `AUTH_ERROR_PATTERNS` (`process.ts:43`) catches auth-shaped text and drives ShipIt's
  own re-auth flow, which for an API-keyed service is both wrong and unfixable. That
  interception must not apply to a key-authenticated service; the turn stops and says
  so.

  Note what this does *not* require: ShipIt never has to decide whether a given error
  means "quota spent" or "key is bad". The branch is on the credential type, which is
  known before the turn starts — and it has to be, because the error cannot carry it:
  Claude's matching output is reduced to a payload-free `auth_required` event
  (`process.ts:173`), so the orchestrator already recovers the route separately
  (`turn-executor.ts:365`).

  An earlier draft said subscription failover and account recovery "stay exactly as they
  are". That overstates today's coverage in two ways, both of which are work: the quota
  retry is not route-gated (above), and this analysis covers only Claude's
  `AUTH_ERROR_PATTERNS`. Codex classifies separately (`codex/adapter.ts:324`), and a
  Codex `turn/start` quota failure can arrive as a rejected JSON-RPC request
  (`codex/adapter.ts:723`) that becomes an adapter `error` rather than the
  `agent_result` the quota retry watches. Per-harness coverage has to be established,
  not assumed.

## Key files

| File | Why it matters |
|---|---|
| `shared/agent-registry.ts` | `AGENT_DEFS`, `CLAUDE_MODELS`, `ALLOWED_ENV_KEYS`, `isAllowedAgentEnvKey` |
| `shared/types/agent-types.ts` | `AgentId` — the conflation lives here |
| `session/agents/claude/process.ts` | Both spawn sites, the scrub, `AUTH_ERROR_PATTERNS` |
| `orchestrator/provider-account-manager.ts` | `reservedRouteFor`, `hasAnyAuthForProvider` — route eligibility |
| `orchestrator/session-agent-env.ts` | `selectAgentEnvForPush` — credential delivery to a container |
| `orchestrator/local-agent-home.ts` | `resolveLocalAgentHome` — why reserved routes are unscoped |
| `shared/model-windows.ts` | First-frame context window |
| `client/components/ModelAgentSelector.tsx` | Picker, `METERED_MODELS` |
| `shared/types/usage-limits-types.ts` | `SubscriptionLimits` — already keyed by `routeId` |
| `orchestrator/agents/*/limits-provider.ts` | Per-`AgentId` today; becomes per service (req 10) |
| `orchestrator/usage.ts` | `RecordedTurn` — token/cost accounting, distinct from quota |
| `orchestrator/session-namer.ts` | Non-turn spawn with no service seam (req 9) |

## Appendix A — findings from the spike

All verified against the code on this branch, not inferred.

### The credential pipe exists, but does not reach every session

`CredentialStore.agentEnv` → `selectAgentEnvForPush` (`session-agent-env.ts:217`) →
`PUT /secrets` on the worker → worker `process.env` → `spawnEnv = {...process.env}`,
gated by `isAllowedAgentEnvKey` (`agent-registry.ts:314`).

**Two corrections found by review, both load-bearing:**

1. That path only applies to a **compose-less** session. When the runner has a
   `ServiceManager`, `selectAgentEnvForPush` returns the ServiceManager snapshot
   instead, which merges compose-declared secrets with MCP secrets — and
   `collectMcpAgentEnv` filters to keys starting with `mcp__` (`secret-resolver.ts:308`).
   An ordinary top-level key stored in Settings therefore **does not** reach a
   containerized session that has a compose stack. Any design that relies on this pipe
   has to extend it, not merely add a key name.

2. `ALLOWED_ENV_KEYS` is a **compile-time constant** (`agent-registry.ts:303`), so one
   key name per service means one code change per service.

   This *used* to contradict req 7, when req 7 promised that trying a new service
   needed no release. It no longer does: the catalogue ships with ShipIt, so a new
   service is already a ShipIt change, and adding its key name in the same change costs
   nothing extra. **The requirement that justified building a runtime credential
   mechanism has disappeared, so the mechanism should not survive it** — a compile-time
   key name per catalogue service is now the simpler and sufficient answer.

The compose gap in (1) is unaffected and still has to be closed, on its own merits
rather than as a consequence of req 7.

### The credential-scrub only applies to local mode

`scrubEnvAuthForScopedHome` (`process.ts:28`) deletes `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN`, but only when a **scoped home** is set. `session-worker.ts:742`
constructs `new ClaudeProcess()` with no resolver, so containerized sessions are never
scrubbed; only the local-mode factory (`app-di.ts:574`) passes one. And
`resolveLocalAgentHome` (`local-agent-home.ts:82`) returns `undefined` for the reserved
env routes anyway.

Consequence: a custom credential must **not** reuse an Anthropic variable name, or the
route works or fails depending on how the install happens to be signed in — a
difference unrelated to the feature. A distinct name (`DEEPSEEK_API_KEY`) sidesteps it
entirely, and behaves identically in a container, in local mode, and under dogfood.

### There are two spawn sites, not one

`ClaudeProcess.run` (PTY) and `StreamingClaudeProcess.run` both build a spawn env.
**Streaming is the default whenever live steering is on**, so anything wired into only
the PTY path unit-tests green and does nothing in a real session. Confirmed in the
dogfood run: the log line was `[streaming-claude] spawning:`.

Any env-shaping for custom models must be applied at both, and **after** the scrub —
ordering is load-bearing, and is pinned by a test.

### API style is a property of the service, and services differ

DeepSeek V4 Flash is served by DeepSeek, DeepInfra, Parasail, Fireworks and
SiliconFlow, aggregated by OpenRouter, plus open weights for self-hosting. API style
varies per service and is not inferable from the model: DeepSeek exposes an
Anthropic-style surface (`/anthropic`), OpenRouter exposes an Anthropic Messages
endpoint *and* OpenAI-style ones, while several others are OpenAI-style only. Pointing
a harness at a service that does not speak its style fails at the **wire format**, not
at auth — a failure that looks nothing like a bad key.

(An earlier draft claimed only DeepSeek served an Anthropic-style surface. That was
wrong, and the correction strengthens the case for storing style per service rather
than hardcoding one endpoint.)

DeepSeek itself speaks **both** — the `/anthropic` endpoint and, per its own docs, the
OpenAI Responses API with a Codex adaptation. So one DeepSeek key surfaces models under
both harnesses — but *not necessarily the same models*: only `deepseek-v4-flash` is
supported under Codex today, which is precisely why req 6 makes the per-model
declaration part of the service rather than deriving it from the style set. An
OpenAI-style-only service surfaces under Codex alone.

### Two things break — and a third that only looked broken

1. **A 401 triggers the wrong recovery.** `AUTH_ERROR_PATTERNS` (`process.ts:43`)
   matches `"unauthorized"` / `"authentication_error"`, so a bad custom key kicks the
   session into the *harness vendor's* OAuth re-auth flow, which cannot fix it.
2. **Non-turn CLI spawns fail — but the two are not the same path.** Corrected on
   review: session naming *does* have a credential seam, selecting the route a turn
   would use and passing that account's credential root
   (`graduate-session.ts:250`, `session-namer.ts:28`); it is implicit and agent-bound,
   not absent. What it lacks is an *explicit, user-selected* model (req 9). PR
   descriptions go through `generateText`, which in containerized production has no
   in-process factory and returns an empty string rather than spawning at all
   (`app-di.ts:485`) — so it degrades silently instead of failing.
   The observed `[session-namer] claude CLI failed` was the *local-mode* path, where a
   reserved route resolves no account root. These are two designs, not one.

Both are code that assumes a service identity the type system cannot express — the
same gap as above, surfacing twice. Neither should be patched individually.

The third symptom, an **empty usage pill** (`ClaudeLimitsProvider` is event-fed from
`agent_rate_limits`, which a non-Anthropic service does not emit), was originally
recorded here as a bug. It is not one: once the indicator is per-service, a service
with no quota *should* show nothing (req 10). Kept in this list because the mistake is
easy to repeat — the correct behavior is indistinguishable from the bug by inspection.

### Prompt caching is not portable

`PRECOMPUTED_INSTRUCTIONS` renders every prompt variant once at module load
specifically to keep the CLI string byte-stable for Anthropic's prompt cache. Another
service has its own cache semantics, so cost and latency on its models are not
comparable to the tuned path, in either direction.

## Appendix B — relationship to the spike

An **experimental spike** was written before this document, to answer "does this work at
all", and **removed from this branch on 2026-08-05** once it had. It was never an
implementation of these requirements: it hardcoded a single model id in `CLAUDE_MODELS`,
hardcoded DeepSeek's endpoint, and made `hasAnyAuthForProvider`/`reservedRouteFor` treat
a DeepSeek key as a Claude-provider route — an overstatement it accepted deliberately,
and which req 8 now rules out. It was deleted rather than kept because shipping a
design alongside an implementation that contradicts it is worse than shipping neither.
The code is recoverable from this branch's history if anyone wants to re-run the
experiment.

**It did establish that the approach works.** A full session ran on DeepSeek V4 Flash
through the unmodified Claude Code harness: multi-step tool use, correct output, a
second dispatched turn, with `providerRouteId: claude-api-key` and no backend
credential present. That is the evidence req 1 is achievable; everything else about the
spike is scaffolding.

## Appendix C — verifying a service in dogfood

Not a requirement — a working note, kept because it is how this branch was validated
and it is not obvious. Declare the credential in the `dev` service's
`x-shipit-secrets`, set it in the **outer** Settings → Secrets, `shipit service restart dev`
(a running service does not pick up a newly declared secret), then drive the inner
instance over its API — `POST /api/sessions/headless` with `model`, then
`/agent/dispatch`, `/status`, `/history`.

**What this does not prove:** local mode spawns agents in-process and never exercises
the container path (`session-worker.ts:742`). A green dogfood run shows the model and
the stream parsing work; it does not validate a containerized session.
