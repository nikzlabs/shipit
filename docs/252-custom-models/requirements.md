# 252 — Custom models: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

**Status: one open question below still blocks implementation.** The experimental
spike on this branch (PR #1997) predates this document and is not an implementation
of it — see `plan.md` § "Relationship to the spike".

## Requirements

1. A user can run a ShipIt session on a model that is not made by the agent
   backend's own vendor — for example DeepSeek V4 Flash on the Claude Code
   harness — and the session works like any other session.

2. This does not require the user to install, configure, or switch to a different
   agent CLI. The harness stays the one they already use.

3. Selecting such a model works the same way as selecting any other model, in the
   same place.

4. Everything ShipIt normally does inside a session keeps working on a custom
   model: tools, skills, MCP servers, live steering, permission modes, plan mode,
   and the transcript.

5. The user supplies their own credential for the custom model, and provides it
   the same way they provide any other secret.

6. ShipIt is honest about what a session is running on. The user can tell which
   model is in use, and can tell that a custom model bills against their own key
   rather than a connected subscription.

7. A user can try a model this way cheaply — without ShipIt shipping support for
   it first, and without merging anything.

8. The thing a user adds is a **service**, identified by its API key — not a
   model, and not a harness. Adding a DeepSeek key adds DeepSeek.

9. A service may speak more than one API style, and a harness speaks one. A
   service's models are usable in **every** harness whose API style that service
   speaks. A service that speaks both is usable in both Claude Code and Codex; a
   service that only speaks the OpenAI style is usable in Codex only.

10. When a new harness is added to ShipIt later, every already-configured service
    that speaks its API style becomes usable with it, with no further work by the
    user.

11. A user adds and manages their own services, in their own Settings. Trying a new
    service or model does not require an administrator, a code change, or a release.

12. ShipIt only offers models it can actually run. A model whose service has no
    configured credential is not selectable, including the agent backend's own
    models when no account for that backend is connected.

13. The work ShipIt does outside a turn — naming a session, writing a pull-request
    description — runs on the user's selected model too, so an install configured
    only with a custom service is fully functional.

## Open questions

- **What should the usage indicator show for a custom model?** The subscription
  pill is fed by rate-limit events the backend's own API emits, which a custom
  service does not send. Options: (a) hide it for custom-service sessions; (b) show
  token spend instead; (c) leave it blank. *Recommendation: (a) — a blank pill reads
  as a bug, and token spend is a bigger feature than it looks.*

## Resolved questions

- 2026-08-05 — How far should "any custom model" reach: only providers already
  serving a harness-compatible API, or also OpenAI-compatible ones through a
  gateway? **Chosen: neither — the framing was wrong.** The primitive is the
  *service*, defined by its API key. A service may support several API styles, and
  therefore several harnesses; compatibility is derived from that overlap rather than
  being a scope decision. A DeepSeek key yields DeepSeek models in both Claude Code
  and Codex; a service speaking only the OpenAI style yields Codex only; a harness
  added later automatically picks up the services that speak its style. Requirements
  8, 9 and 10 were added; the gateway question is no longer the axis and is dropped.

- 2026-08-05 — Who decides which custom models exist? Chosen: each user, in their own
  Settings — not an admin-curated list and not the source tree, both of which
  contradict requirement 7. Requirement 11 was added.

- 2026-08-05 — When only a custom credential is configured, what happens to the
  backend's own models? Chosen: model-level eligibility, so models with no usable
  credential are not selectable. Requirement 12 was added.

- 2026-08-05 — Should non-turn work (session naming, PR descriptions) run on the
  custom model? Chosen: yes, route it through the same model. Requirement 13 was
  added.

## Requirement provenance

Recorded because the generalization from "DeepSeek Flash" to "any custom model" came
from the human, but most of the mechanism did not. What the human actually said, in
order:

- "DeepSeek Flash … what harness is the best for it, and how hard would it be to
  integrate it into ShipIt?" → the feature exists at all.
- "Now I'm considering to play with a new model, from inside ShipIt." → req 7.
- "so I can test whether it works at all, before merging" → req 7.
- "supporting DeepSeek Flash in Claude Code, essentially supporting any custom
  model" → reqs 1, 2, 3. The generalization beyond DeepSeek is the human's.
- "start from the service, which is defined by the API key … every service may
  support various APIs and thus harnesses … if we add another harness in the future,
  it would be also supported for some of the API keys" → reqs 8, 9, 10. This
  replaced the agent's own framing, which had treated API compatibility as a scope
  boundary rather than as a property of each service.
- Answers of 2026-08-05 → reqs 11, 12, 13.

Reqs 4, 5 and 6 are the agent's reading of "works like any other session" and of
ShipIt's existing product principles. They are stated as requirements rather than open
questions because they restate expectations ShipIt already meets everywhere else — but
they were not said out loud, and should be struck if wrong.

Everything the agent learned while spiking — the harness/provider split, spawn-site
ordering, which environment variables carry a credential — is design, and lives in
`plan.md`.
