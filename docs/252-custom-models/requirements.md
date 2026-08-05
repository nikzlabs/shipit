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

6. Everything ShipIt normally does inside a session keeps working on any model:
   tools, skills, MCP servers, live steering, permission modes, plan mode, and the
   transcript.

7. The thing a user adds is a **service**, identified by its API key or its
   subscription — not a model, and not a harness. Anthropic and OpenAI are services
   like any other and work the same way; harness and service are fully separate
   concepts throughout.

8. A service may speak more than one API style, and a harness speaks one. A service
   declares which of its models work under which API style — a service can speak a
   style without every one of its models being usable there. A model is offered on a
   harness when the service speaks that harness's style **and** declares that model
   for it.

9. When a new harness is added to ShipIt later, the services that already speak its
   API style become usable with it as far as their declarations reach, with no
   further work by the user beyond declaring any models they had not covered yet.

10. A user adds and manages their own services, in their own Settings. Trying a new
    service or model does not require an administrator, a code change, or a release.

11. ShipIt only offers models it can actually run. A model whose service has no
    configured credential is not selectable — this is one rule applying uniformly to
    every service, with no service treated as the default or built-in one.

12. The work ShipIt does outside a turn — naming a session, writing a pull-request
    description — runs on a service the user configures explicitly for it, chosen
    independently of whatever model a session is using. It must not silently depend
    on a credential the user has stopped having.

13. Usage is reported per **service**, not per model. A service may expose its own
    quota or subscription, and the indicator reflects whatever the service in use
    reports. A service with no quota to report — an ordinary API key, which has no
    allowance and nothing that resets — shows no indicator at all, rather than an
    empty or placeholder one.

14. ShipIt is honest about what a session is running on. The user can tell which
    model and which service are in use, and whether that service bills a key or a
    subscription.

15. When a service's credential stops working mid-session — revoked, expired, rate
    limited — ShipIt stops and says so. It does not run a recovery or re-prompt flow
    of its own; handling a bad credential is the harness's job. The one exception is
    the thing harnesses do not do: ShipIt manages a user's **multiple subscriptions**,
    including routing a turn between them, and that existing behavior is unchanged.

## Open questions

_None._

## Resolved questions

- 2026-08-05 — Can one service offer different models to different harnesses?
  **Chosen: (b) — a service declares which of its models work under which API style.**
  Compatibility is therefore a property of *service × model × harness*, not service ×
  harness. Reqs 8 and 9 were narrowed accordingly: req 9's "no further work by the
  user" now holds only as far as a service's declarations already reach. The cost is
  more configuration per service; the alternative was offering models that are listed
  and then fail, which is the failure mode req 12 exists to prevent elsewhere.

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
  not the axis.

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
- Answers of 2026-08-05 → reqs 10, 11, 12, 13, 15.

Reqs 6 and 14 are the agent's reading of "works like any other session" and of
ShipIt's existing product principles. They are stated as requirements rather than open
questions because they restate expectations ShipIt already meets everywhere else — but
they were not said out loud, and should be struck if wrong.

Everything the agent learned while spiking — spawn-site ordering, which environment
variables carry a credential, where eligibility is computed — is design, and lives in
`plan.md`.
