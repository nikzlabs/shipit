# 252 — Custom models: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

No open questions remain.

## Requirements

1. A user can run a ShipIt session on a model from any service they have
   configured — for example DeepSeek V4 Flash on the Claude Code harness — and the
   session works like any other session.

2. Using a harness does not require an account or key with that harness's own
   vendor. A user whose only credential is a DeepSeek key can use the Claude Code
   harness; nothing about the harness assumes an Anthropic account exists.

3. Choosing a model does not mean installing, configuring, or switching to a
   different agent CLI. The harness stays the one the user already has.

4. Selecting a model works the same way for every model, in the same place.

5. A user can switch models within a session while keeping the same harness, as far
   as that harness supports it.

6. ShipIt makes its normal session features available on any model on a **best-effort**
   basis: tools, skills, MCP servers, live steering, permission modes, plan mode, and
   the transcript. It adds no limitation of its own — but it cannot fix a harness or a
   model either. Codex declares no permission-mode or image support; a model that cannot
   call tools cannot run skills or MCP servers whichever harness drives it; a model that
   uses tools poorly will use them poorly. Those are properties of the harness and the
   model, not defects in ShipIt, and this requirement does not promise otherwise.

7. The thing a user adds is a **service** — not a model, and not a harness. Harness and
   service are fully separate concepts throughout, and Anthropic and OpenAI are services
   like any other rather than privileged defaults.

   A service is authenticated either by an API key or by a subscription. **A service the
   user adds themselves is key-authenticated.** Subscription-backed services are those
   ShipIt implements support for, because each subscription needs its own login,
   refresh, and account handling that cannot be inferred from configuration. Adding a
   new subscription-backed service is out of scope for this feature.

8. A service may speak more than one API style, and a harness speaks one. Which of a
   service's models work under which API style is **declared in ShipIt, by ShipIt's
   developers** — a service can speak a style without every one of its models being
   usable there. A model is offered on a harness when the service speaks that harness's
   style **and** is declared to support that model there.

   Writing those declarations must not mean one entry per model: it must be possible to
   cover many models of a service with a single piece of configuration, so that a
   service offering hundreds of models is no more work than one offering three.

9. When a new harness is added to ShipIt later, the services that already speak its
   API style become usable with it as far as their declarations reach, with no
   further work by the user beyond declaring any models they had not covered yet.

10. A user adds and manages their own services in their own Settings by supplying
    credentials for them — no administrator, and no involvement from anyone else, to
    start using a service ShipIt knows about.

    The catalogue itself — which services exist, which API styles each speaks, and which
    of their models work where — ships with ShipIt (req 8). So a service or model ShipIt
    does not yet know about does require a ShipIt change. This is a deliberate narrowing
    of an earlier answer; see the receipts.

11. ShipIt only offers models it can actually run. A model whose service has no
    configured credential is not selectable — this is one rule applying uniformly to
    every service, with no service treated as the default or built-in one.

12. The work ShipIt does outside a turn — naming a session, writing a pull-request
    description — runs on a service the user configures explicitly for it, chosen
    independently of whatever model a session is using. It must not silently depend
    on a credential the user has stopped having.

    When that service fails, the surrounding operation still completes on its existing
    fallback — a session keeps its placeholder title, a pull request gets its generic
    description — and ShipIt shows a dismissible notice saying which service failed.
    Failure of background work never blocks the operation around it, and is never
    silent either.

13. Usage is reported per **service**, not per model. A service may expose its own
    quota or subscription, and the indicator reflects whatever the service in use
    reports. A service with no quota to report — an ordinary API key, which has no
    allowance and nothing that resets — shows no indicator at all, rather than an
    empty or placeholder one.

14. ShipIt is honest about what a session is running on. The user can tell which model
    and which service are in use, and whether that service bills a key or a
    subscription.

15. When a service's credential stops working mid-session — revoked, expired, rate
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

## Open questions

_None._

## Resolved questions

- 2026-08-05 — Who authors a service's per-model declarations, and what keeps them
  fresh? **Chosen: ShipIt's developers author them, with configuration that can cover
  many models at once.** Not user-authored and not auto-discovered. Requirement 8 gained
  the authorship and the "one config covers many models" constraint, which is what keeps
  an aggregator's hundreds of models from being hundreds of entries.

  **This narrowed requirement 10.** That requirement previously said trying a new service
  or model needs no code change or release; with the catalogue shipping in ShipIt, a
  service ShipIt does not know about *does*. Req 10 was rewritten so what the user owns
  is the **credential**, and the catalogue is ShipIt's. The two answers are recorded
  separately rather than merged, because the second changes the first.

- 2026-08-05 — Are user-added *subscription* services in scope? **Chosen: no, out of
  scope for now.** Each subscription needs custom ShipIt-side support — its own login,
  refresh, and account handling — which cannot be inferred from configuration. A service
  a user adds is key-authenticated; subscription-backed services remain the ones ShipIt
  implements. Requirement 7.

- 2026-08-05 — What should failure of non-turn work look like? **Chosen: (a) keep the
  existing fallbacks and surface a dismissible notice.** The operation still completes —
  placeholder title, generic pull-request description — and the user is told which
  service failed. Background failure neither blocks the operation nor passes silently.
  Requirement 12.

- 2026-08-05 — Confirm or strike requirements 6 and 14, both agent-supplied. **Chosen:
  both kept.** Req 6 additionally gained a *model*-capability qualifier alongside the
  harness one: a model that cannot call tools cannot run skills or MCP servers whatever
  the harness does. Refined further the same day, on the human's framing — "ShipIt works
  best effort for models/harnesses, it can't fix them" — so the requirement is now
  explicitly best-effort. It does not promise a given model works well, only that ShipIt
  imposes nothing extra. A model that handles tools badly is not a ShipIt defect.

- 2026-08-05 — Can one service offer different models to different harnesses?
  **Chosen: (b) — a service declares which of its models work under which API style.**
  Compatibility is therefore a property of *service × model × harness*, not service ×
  harness. Reqs 8 and 9 were narrowed accordingly: req 9's "no further work by the
  user" now holds only as far as a service's declarations already reach. The cost is
  more configuration per service; the alternative was offering models that are listed
  and then fail, which is exactly what req 11 forbids.

- 2026-08-05 — At the moment a credential failure arrives, can ShipIt tell a spent
  subscription apart from a bad key? **Chosen: it does not have to.** The rule keys on
  how the service is authenticated — subscriptions fail over, API keys do not — which
  ShipIt knows statically from its own configuration, instead of having to classify an
  error whose text is not reliable. Failover is scoped to subscriptions of the *same*
  service, because that is the only case that is lossless: the model and price are
  unchanged and the user need not be consulted. This generalizes an existing rule
  rather than inventing one — ShipIt already excludes metered API-key routes from quota
  tracking and never fails over onto them (docs/150 req 12). Requirement 15 rewritten.

- 2026-08-05 — What should happen when a configured service's credential stops working
  mid-session? **Chosen: stop, and report it — nothing more.** Recovering from a bad
  credential is the harness's responsibility, not ShipIt's. ShipIt's involvement in
  credentials is deliberately limited to the one thing harnesses do not do: letting a
  user run several subscriptions and routing between them. Requirement 15. This
  *removes* designed behavior rather than adding it — the plan had proposed a
  service-aware re-prompt flow, which is now explicitly out of scope.

- 2026-08-05 — What should the indicator show for a service that has no quota to
  report? **Chosen: (a) render no indicator.** This preserves what a key-based
  credential already does today rather than introducing a new behavior. Showing
  accumulated spend or token counts there was considered and rejected *for this
  feature* — it is buildable, but it is a separate feature and should not be decided
  as a side effect of this one. Folded into requirement 13. (Why it is the status quo,
  in code terms, is in `plan.md`.)

- 2026-08-05 — How far should "any custom model" reach: only providers already
  serving a harness-compatible API, or also OpenAI-compatible ones through a
  gateway? **Chosen: neither — the framing was wrong.** The primitive is the
  *service*, defined by its API key or subscription. A service may support several
  API styles, and therefore several harnesses; compatibility is derived from that
  overlap rather than being a scope decision. A DeepSeek key yields DeepSeek models
  in both Claude Code and Codex; a service speaking only the OpenAI style yields
  Codex only; a harness added later automatically picks up the services that speak
  its style. Requirements 7, 8 and 9 were added; the gateway question is dropped as
  not the axis. *(Later narrowed the same day — a service's models are not all usable
  under every style it speaks; see the compatibility receipt above.)*

- 2026-08-05 — Who decides which custom models exist? Chosen: each user, in their own
  Settings — not an admin-curated list and not the source tree. Requirement 10.

- 2026-08-05 — When only a custom credential is configured, what happens to the
  backend's own models? Chosen: model-level eligibility, so models with no usable
  credential are not selectable. Reframed on review: there is no "backend's own"
  category — the rule applies uniformly to every service, which is the clearer
  statement of the same gist. Requirement 11.

- 2026-08-05 — Should non-turn work (session naming, PR descriptions) run on the
  custom model? Chosen initially: yes, follow the session's model. **Revised the same
  day on review**: it must be *explicitly configurable* and chosen independently of
  the session's model. The human reported session naming breaking in practice when
  their Claude subscription expired and they switched to Codex — following the
  session's model would not have prevented that, because the failure was a
  credential disappearing underneath work that silently assumed it. Requirement 12.

- 2026-08-05 — Should "a user can try a model cheaply, without ShipIt shipping
  support for it first" be a requirement? **Chosen: no — removed.** The human noted
  that configuring a service *is* how a model becomes supported, so the statement
  described the feature rather than constraining it. Supporting additional harnesses
  is orthogonal and not part of this feature.

- 2026-08-05 — What should the usage indicator show for a custom model? **Chosen:
  the question was mis-framed.** Usage belongs to the service, not the model, and a
  service may have its own subscription that ShipIt supports later — so the
  abstraction has to be flexible enough to carry that. Requirement 13. The narrower
  residual question it left — services that report nothing — was resolved the same day
  (first receipt above).

## Requirement provenance

Recorded because the generalization from "DeepSeek Flash" to any model came from the
human, but most of the mechanism did not. What the human actually said, in order:

- "DeepSeek Flash … what harness is the best for it, and how hard would it be to
  integrate it into ShipIt?" → the feature exists at all.
- "supporting DeepSeek Flash in Claude Code, essentially supporting any custom
  model" → reqs 1, 3, 4. The generalization beyond DeepSeek is the human's.
- "start from the service, which is defined by the API key … every service may
  support various APIs and thus harnesses … if we add another harness in the future,
  it would be also supported for some of the API keys" → reqs 7, 8, 9. This replaced
  the agent's framing, which had treated API compatibility as a scope boundary
  rather than as a property of each service.
- "using claude or codex doesn't require authenticating with the respective model
  provider … without having a key or account with anthropic or openai" → req 2.
- "we should also allow freely switching models within a session (keeping the same
  harness), to the extent how this is supported by the harness" → req 5.
- "or subscription. And Anthropic/OpenAI services should work the same way" → req 7.
- "we need to aim for full separation between harness and service providers" → the
  reframing of req 11, and the wording throughout.
- "probably need to make it explicitly configurable. I already had an issue when
  claude subscription expired and I used codex, but session naming broke" → req 12.
- "a 'service' may have its own subscriptions that ShipIt may support (in the
  future) … the usage indicator already shows usage for a service, not for a model"
  → req 13.
- "(a) render no indicator, which is what a key-based route does today" → the closing
  sentence of req 13.
- "(b) narrow them so a service declares which of its models work on which API style"
  → the narrowing of reqs 8 and 9.
- "We just stop. This is the harness' responsibility to handle such cases. ShipIt only
  helps with using multiple subscriptions, because harnesses don't handle it." → req 15,
  including its scope boundary and the carve-out for multi-subscription routing.
- "I'd say that subscriptions should fail over but not API keys" → the rule in req 15.
- "failover between subscriptions of the same service" → its scoping to a single
  service.
- "ShipIt developers (me), with a convenient way to cover many models with a single
  config" → req 8's authorship and compactness constraints, and the narrowing of req 10.
- "each subscription would require custom support from the ShipIt side. So it is out of
  scope of this feature for now" → req 7's key-authentication limit.
- "(a) keep the existing fallbacks and surface a dismissible notice" → req 12's failure
  behavior.
- "sounds good" (req 6) and "good" (req 14) → both confirmed as requirements.
- "ShipIt works 'best effort' for models/harnesses, it can't fix them" → req 6's
  best-effort framing.
- Answers of 2026-08-05 → reqs 6, 7, 8, 10, 11, 12, 13, 14, 15.

Reqs 6 and 14 are the agent's reading of "works like any other session" and of
ShipIt's existing product principles. They are stated as requirements rather than open
questions because they restate expectations ShipIt already meets everywhere else — but
they were not said out loud, and should be struck if wrong.

Everything the agent learned while spiking — spawn-site ordering, which environment
variables carry a credential, where eligibility is computed — is design, and lives in
`plan.md`.
