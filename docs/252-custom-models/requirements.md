# 252 — Custom models: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

No open questions remain.

## Requirements

1. A user can run a ShipIt session on a model from any service they have
   configured — for example DeepSeek V4 Flash on the Claude Code harness — and the
   session works like any other session, on a **best-effort** basis. ShipIt adds no
   limitation of its own — but it cannot fix a harness or a model either. Codex declares
   no permission-mode or image support; a model that cannot call tools cannot run skills
   or MCP servers whichever harness drives it; a model that uses tools poorly will use
   them poorly. Those are properties of the harness and the model, not defects in ShipIt,
   and this requirement does not promise otherwise.

2. Using a harness does not require an account or key with that harness's own
   vendor. A user whose only credential is a DeepSeek key can use the Claude Code
   harness; nothing about the harness assumes an Anthropic account exists.

3. Selecting a model works the same way for every model, in the same place.

4. A user can switch models within a session while keeping the same harness, as far
   as that harness supports it.

5. A service is authenticated by an API key or by a subscription. Supporting a
   subscription takes per-service work on ShipIt's side — its own login, refresh, and
   account handling — so this feature adds **key-authenticated** services;
   subscription-backed services remain the ones ShipIt already implements.

6. A service may speak more than one API style, and a harness speaks one. A model is
   offered on a harness when the service speaks that harness's style **and** the
   catalogue declares that model works there — a service can speak a style without every
   one of its models being usable under it.

   The catalogue does not mirror everything a service offers. ShipIt lists a
   **maintained subset** — at any moment only a handful of models are worth using for
   coding — so a service advertising hundreds of models does not become hundreds of
   entries. Breadth of the subset is a judgement ShipIt makes and revises over time.

7. A user chooses which of ShipIt's services they use, in their own Settings, by
   supplying a credential for each — no administrator and no involvement from anyone
   else to start using a service ShipIt defines. What the user owns is the credential;
   the service itself is ShipIt's, and Anthropic and OpenAI are services like any other
   rather than privileged defaults.

   The catalogue itself — which services exist, which API styles each speaks, and which
   of their models work where — is authored by ShipIt's developers and ships with ShipIt
   (req 6). So a service or model ShipIt does not yet know about does require a ShipIt
   change. This is a deliberate narrowing of an earlier answer; see the receipts.

8. A model is selectable only when its service has a credential configured. One rule
   applies uniformly to every service, with none treated as a default or built-in: so
   "Claude with no account connected" and "DeepSeek with no key" are the same
   condition, and neither is offered.

   This is about credentials, and nothing else. Whether a selectable model then works
   *well* is req 1's best-effort territory — ShipIt does not guarantee that every
   model and harness combination performs, only that it never offers a model it has no
   credential for.

9. The work ShipIt does outside a turn — naming a session, writing a pull-request
   description — runs on a model the user chooses for it, independently of whatever
   model a session is using. It is a model like any other, chosen the same way (req 3),
   so it names both a service and a model rather than a service alone.

   That choice is **visible in the UI as its own setting**, and ShipIt supplies a
   reasonable default so nobody has to configure it before ShipIt works. A default is
   acceptable where a hidden dependency is not: the user can see what non-turn work
   runs on and change it. It must not silently depend on a credential the user has
   stopped having.

   When that service fails, the surrounding operation still completes with a fallback
   — a session keeps its placeholder title, and a pull request gets a generic
   description rather than an empty one — and ShipIt shows a dismissible notice saying
   which service failed. Failure of background work never blocks the operation around
   it, and is never silent either.

   The pull-request half is a **change**, not a preserved behavior: today a failed or
   unavailable generation yields an empty description, and the generic text exists only
   for a thrown error. The notice must also still be findable after a reload or a
   session switch — a message that vanishes with the tab is silent in practice.

10. Usage is reported per **service**, not per model. A service may expose its own
    quota or subscription, and the indicator reflects whatever the service in use
    reports. A service with no quota to report — an ordinary API key, which has no
    allowance and nothing that resets — shows no indicator at all, rather than an
    empty or placeholder one.

11. ShipIt is honest about what a session is running on. The user can tell which model
    and which service are in use, and whether that service bills a key or a
    subscription.

12. When a service's credential stops working mid-session — revoked, expired, rate
    limited — what ShipIt does depends on **how that service is authenticated**, not on
    what the error says:

    - **Subscriptions fail over.** If the user has more than one subscription to that
      same service, ShipIt moves the turn to another of them, as it does today.
      Failover never crosses to a *different* service: two subscriptions to one service
      are interchangeable, but another service means a different model at a different
      price, which is the user's choice to make and not ShipIt's.
    - **API keys do not fail over.** ShipIt stops and says so. Recovering from a bad
      key is the harness's job; ShipIt runs no recovery or re-prompt flow of its own.

    When no subscription is left to fail over to, ShipIt stops and says so, exactly as
    it does for a key.

13. Models leave the catalogue as ShipIt revises which ones are worth carrying (req 6).
    A session already pinned to a removed model keeps working: each service maps its own
    retired models to their successors, and the session moves onto the successor. A
    successor is always another model **of the same service** — a retirement never moves
    a session to a different service, which would change the credential it needs, the
    price it pays, and who provides it. The session then reports what it is actually
    running (req 11) — a remap is never invisible, and never leaves a session unable to
    take a turn.

## Open questions

_None._

## Resolved questions

- 2026-08-06 — Which requirements could be **removed**? **Chosen: cut 16 to 13.** A review
  round was run with the inverted brief CLAUDE.md prescribes — for each requirement, would
  anyone notice if it were deleted? — because every prior round had added mechanism and
  none had removed any. Deleted outright: the old req 3 (the harness stays put), derivable
  from reqs 1, 2 and 4; and the old req 9 (a new harness picks up services already speaking
  its style), derivable from req 6's offering rule. Folded: the old req 6's best-effort
  qualifier into req 1, dropping its enumeration of session features — the qualifier had to
  move rather than vanish, because it exists to *weaken* req 1 and deleting it outright
  would have left req 1 promising more than was ever agreed. Trimmed: the old req 7 down to
  its key-versus-subscription scope limit (its "first-class concept" framing was already
  carried by reqs 7 and 8), and the old req 8 down to its offering rule and curation (its
  authorship clause moved into req 7). Everything from here down is dated 2026-08-05 and
  cites the **old** numbering where a requirement no longer exists under any number.

- 2026-08-05 — Can a retirement move a session to a different service? **Chosen: no —
  the map is between models of a single service.** Review found req 13 as first written
  promised a session "never left unable to take a turn" while allowing a successor on any
  service, including one the user has no credential for, which req 8 would then refuse
  to offer. Scoping the map inside a service removes the contradiction at its source
  rather than patching it: the credential, the price and the provider are all unchanged
  by a remap, so there is nothing left to fail. Requirement 13; the design's
  "keyed by pair" framing goes with it.

- 2026-08-05 — Non-turn work names a *service*, but running it needs a model. **Chosen:
  make it explicit in the UI, with a reasonable ShipIt-supplied default.** It is a model
  choice like any other (req 3), naming a service and a model. The default is what keeps
  this from being configuration everyone must do before ShipIt works; making the setting
  visible is what keeps the default from being the silent dependency req 9 exists to
  prevent. Requirement 9.

- 2026-08-05 — What happens to a session pinned to a model that later leaves the
  catalogue? **Chosen: maintain a fallback map from retired pairs to their successors,
  and move the session onto the successor.** Not "keep running on the removed pair",
  which was the agent's suggestion — that leaves sessions on models ShipIt has stopped
  standing behind. Requirement 13. The gap only exists because curation (req 6) makes
  removal a deliberate, recurring act rather than an accident.

- 2026-08-05 — How do compact declarations coexist with per-model metadata? **Chosen:
  (c) ship only an explicitly maintained subset of a large service's models.** Only a
  handful of models are worth using for coding at any time, so the catalogue carries
  those rather than mirroring a service's full offering. This *removed* a requirement
  rather than adding one: req 6's "one piece of configuration must cover many models"
  constraint is gone, and with it the need for build-time generation or a
  defaults-plus-exceptions scheme. Per-model metadata is no longer in tension with
  anything, because there are few enough models to state it per model.

- 2026-08-05 — What does req 8 promise, and for how long? **Chosen: strip the promise.**
  The requirement bundled two things — a vague "only offers models it can actually run",
  and the credential-eligibility rule chosen earlier the same day. The first is what made
  it unclear and what a stale catalogue could not honour; ShipIt does not guarantee that
  every model and harness combination works (req 1 is best-effort). Req 8 now states
  only the credential rule, which is the part that does real work: it is why the picker
  stops offering `claude-*` models on an install whose only credential is a DeepSeek key.
  With the guarantee gone, no staleness policy is needed — a model that stops working is
  a catalogue update, and req 1's best-effort clause covers the interim.

- 2026-08-05 — Who authors a service's per-model declarations, and what keeps them
  fresh? **Chosen: ShipIt's developers author them, with configuration that can cover
  many models at once.** Not user-authored and not auto-discovered. Requirement 6 gained
  the authorship and the "one config covers many models" constraint, which is what keeps
  an aggregator's hundreds of models from being hundreds of entries.

  **This narrowed requirement 7.** That requirement previously said trying a new service
  or model needs no code change or release; with the catalogue shipping in ShipIt, a
  service ShipIt does not know about *does*. Req 7 was rewritten so what the user owns
  is the **credential**, and the catalogue is ShipIt's. The two answers are recorded
  separately rather than merged, because the second changes the first.

- 2026-08-05 — What is "a service the user adds"? **Chosen: there is no such thing.**
  Services are ShipIt-defined ("hardcoded"); a user supplies credentials for them and
  never describes a new one. This is the same conclusion the catalogue answer reached
  from the other direction — if ShipIt authors the catalogue, a user-invented service
  was never coherent — but reqs 5 and 7 still carried the older phrasing. Both
  rewritten. It also simplifies the receipt below: the scope limit is not "user-added
  services are key-authenticated" but simply that this feature adds key-authenticated
  services to ShipIt's catalogue.

- 2026-08-05 — Are user-added *subscription* services in scope? **Chosen: no, out of
  scope for now.** *(Phrasing superseded by the receipt above — there are no user-added
  services at all; the substance, that this feature adds only key-authenticated
  services, is unchanged.)* Each subscription needs custom ShipIt-side support — its own login,
  refresh, and account handling — which cannot be inferred from configuration. A service
  a user adds is key-authenticated; subscription-backed services remain the ones ShipIt
  implements. Requirement 5.

- 2026-08-05 — What should failure of non-turn work look like? **Chosen: (a) keep the
  existing fallbacks and surface a dismissible notice.** The operation still completes —
  placeholder title, generic pull-request description — and the user is told which
  service failed. Background failure neither blocks the operation nor passes silently.
  Requirement 9.

- 2026-08-05 — Confirm or strike the two agent-supplied requirements (then numbered 6
  and 14; now req 1's best-effort clause and req 11). **Chosen:
  both kept.** The first additionally gained a *model*-capability qualifier alongside the
  harness one: a model that cannot call tools cannot run skills or MCP servers whatever
  the harness does. Refined further the same day, on the human's framing — "ShipIt works
  best effort for models/harnesses, it can't fix them" — so the requirement is now
  explicitly best-effort. It does not promise a given model works well, only that ShipIt
  imposes nothing extra. A model that handles tools badly is not a ShipIt defect.

- 2026-08-05 — Can one service offer different models to different harnesses?
  **Chosen: (b) — a service declares which of its models work under which API style.**
  Compatibility is therefore a property of *service × model × harness*, not service ×
  harness. Req 6 and the then-separate future-harness requirement were narrowed
  accordingly: the latter's "no further work by the user" held only as far as a
  service's declarations already reach. The cost is
  more configuration per service; the alternative was offering models that are listed
  and then fail, which is exactly what req 8 forbids.

- 2026-08-05 — At the moment a credential failure arrives, can ShipIt tell a spent
  subscription apart from a bad key? **Chosen: it does not have to.** The rule keys on
  how the service is authenticated — subscriptions fail over, API keys do not — which
  ShipIt knows statically from its own configuration, instead of having to classify an
  error whose text is not reliable. Failover is scoped to subscriptions of the *same*
  service, because that is the only case that is lossless: the model and price are
  unchanged and the user need not be consulted. This generalizes an existing rule
  rather than inventing one — ShipIt already excludes metered API-key routes from quota
  tracking and never fails over onto them (docs/150 req 12). Requirement 12 rewritten.

- 2026-08-05 — What should happen when a configured service's credential stops working
  mid-session? **Chosen: stop, and report it — nothing more.** Recovering from a bad
  credential is the harness's responsibility, not ShipIt's. ShipIt's involvement in
  credentials is deliberately limited to the one thing harnesses do not do: letting a
  user run several subscriptions and routing between them. Requirement 12. This
  *removes* designed behavior rather than adding it — the plan had proposed a
  service-aware re-prompt flow, which is now explicitly out of scope.

- 2026-08-05 — What should the indicator show for a service that has no quota to
  report? **Chosen: (a) render no indicator.** This preserves what a key-based
  credential already does today rather than introducing a new behavior. Showing
  accumulated spend or token counts there was considered and rejected *for this
  feature* — it is buildable, but it is a separate feature and should not be decided
  as a side effect of this one. Folded into requirement 10. (Why it is the status quo,
  in code terms, is in `plan.md`.)

- 2026-08-05 — How far should "any custom model" reach: only providers already
  serving a harness-compatible API, or also OpenAI-compatible ones through a
  gateway? **Chosen: neither — the framing was wrong.** The primitive is the
  *service*, defined by its API key or subscription. A service may support several
  API styles, and therefore several harnesses; compatibility is derived from that
  overlap rather than being a scope decision. A DeepSeek key yields DeepSeek models
  in both Claude Code and Codex; a service speaking only the OpenAI style yields
  Codex only; a harness added later automatically picks up the services that speak
  its style. Requirements 5 and 6 were added, along with a future-harness requirement
  later deleted as derivable; the gateway question is dropped as
  not the axis. *(Later narrowed the same day — a service's models are not all usable
  under every style it speaks; see the compatibility receipt above.)*

- 2026-08-05 — Who decides which custom models exist? Chosen: each user, in their own
  Settings — not an admin-curated list and not the source tree. Requirement 7.

- 2026-08-05 — When only a custom credential is configured, what happens to the
  backend's own models? Chosen: model-level eligibility, so models with no usable
  credential are not selectable. Reframed on review: there is no "backend's own"
  category — the rule applies uniformly to every service, which is the clearer
  statement of the same gist. Requirement 8.

- 2026-08-05 — Should non-turn work (session naming, PR descriptions) run on the
  custom model? Chosen initially: yes, follow the session's model. **Revised the same
  day on review**: it must be *explicitly configurable* and chosen independently of
  the session's model. The human reported session naming breaking in practice when
  their Claude subscription expired and they switched to Codex — following the
  session's model would not have prevented that, because the failure was a
  credential disappearing underneath work that silently assumed it. Requirement 9.

- 2026-08-05 — Should "a user can try a model cheaply, without ShipIt shipping
  support for it first" be a requirement? **Chosen: no — removed.** The human noted
  that configuring a service *is* how a model becomes supported, so the statement
  described the feature rather than constraining it. Supporting additional harnesses
  is orthogonal and not part of this feature.

- 2026-08-05 — What should the usage indicator show for a custom model? **Chosen:
  the question was mis-framed.** Usage belongs to the service, not the model, and a
  service may have its own subscription that ShipIt supports later — so the
  abstraction has to be flexible enough to carry that. Requirement 10. The narrower
  residual question it left — services that report nothing — was resolved the same day
  (first receipt above).

## Requirement provenance

Recorded because the generalization from "DeepSeek Flash" to any model came from the
human, but most of the mechanism did not. What the human actually said, in order:

- "DeepSeek Flash … what harness is the best for it, and how hard would it be to
  integrate it into ShipIt?" → the feature exists at all.
- "supporting DeepSeek Flash in Claude Code, essentially supporting any custom
  model" → reqs 1 and 3. The generalization beyond DeepSeek is the human's.
- "start from the service, which is defined by the API key … every service may
  support various APIs and thus harnesses … if we add another harness in the future,
  it would be also supported for some of the API keys" → reqs 5 and 6. This replaced
  the agent's framing, which had treated API compatibility as a scope boundary
  rather than as a property of each service.
- "using claude or codex doesn't require authenticating with the respective model
  provider … without having a key or account with anthropic or openai" → req 2.
- "we should also allow freely switching models within a session (keeping the same
  harness), to the extent how this is supported by the harness" → req 4.
- "or subscription. And Anthropic/OpenAI services should work the same way" → req 5.
- "we need to aim for full separation between harness and service providers" → the
  reframing of req 8, and the wording throughout.
- "probably need to make it explicitly configurable. I already had an issue when
  claude subscription expired and I used codex, but session naming broke" → req 9.
- "a 'service' may have its own subscriptions that ShipIt may support (in the
  future) … the usage indicator already shows usage for a service, not for a model"
  → req 10.
- "(a) render no indicator, which is what a key-based route does today" → the closing
  sentence of req 10.
- "(b) narrow them so a service declares which of its models work on which API style"
  → the narrowing of req 6.
- "We just stop. This is the harness' responsibility to handle such cases. ShipIt only
  helps with using multiple subscriptions, because harnesses don't handle it." → req 12,
  including its scope boundary and the carve-out for multi-subscription routing.
- "I'd say that subscriptions should fail over but not API keys" → the rule in req 12.
- "failover between subscriptions of the same service" → its scoping to a single
  service.
- "ShipIt developers (me), with a convenient way to cover many models with a single
  config" → req 6's authorship, and the narrowing of req 7. (The compactness constraint
  this originally added was later replaced by curation — see the receipt.)
- "each subscription would require custom support from the ShipIt side. So it is out of
  scope of this feature for now" → req 5's key-authentication limit.
- "there should be only ShipIt-supported ('hardcoded') services" → reqs 5 and 7, which
  had still described users adding services of their own.
- "we need to maintain the fallback map (old pair -> new pair) and make sure it works"
  → req 13.
- "the map should be between models on a single service, not between pairs" → req 13's
  same-service constraint.
- "we should make it explicit in the UI, with shipit providing a reasonable default"
  → req 9's visible setting and default.
- "yes, update" (req 9's wording) and "simplify" (the future-harness requirement, since
  deleted) → both applied; the agent's
  suggestion to move req 9's third paragraph out was declined, the human judging the
  factual context worth keeping since it states a fact rather than prescribing an
  implementation.
- "(a) keep the existing fallbacks and surface a dismissible notice" → req 9's failure
  behavior.
- "sounds good" (the best-effort statement, now part of req 1) and "good" (req 11)
  → both confirmed as requirements.
- "ShipIt works 'best effort' for models/harnesses, it can't fix them" → req 1's
  best-effort framing.
- "There are only so many models at any point of time that can do good coding" → req 6's
  maintained-subset framing, replacing the compactness constraint.
- "ShipIt as a product doesn't provide guarantees that all model/harness combinations
  will work … maybe strip it?" → req 8 reduced to the credential rule.
- "apply your recommendation" (on which requirements could be removed) → the cut from 16
  requirements to 13; see the first receipt.

Reqs 5, 7 and 9 were corrected on 2026-08-05 after review found they still described
the *superseded* model in which users authored declarations and added services outright,
and claimed a pull-request fallback that does not exist today. Those are corrections to
the agent's drafting, not new decisions.

Req 1's best-effort clause and req 11 are the agent's reading of "works like any other
session" and of ShipIt's existing product principles. They are stated as requirements
rather than open questions because they restate expectations ShipIt already meets
everywhere else — but they were not said out loud, and should be struck if wrong.

Everything the agent learned while spiking — spawn-site ordering, which environment
variables carry a credential, where eligibility is computed — is design, and lives in
`plan.md`.
