# 252 — Custom models: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

**Status: open questions below block implementation.** The experimental spike on
this branch (PR #1997) predates this document and is not an implementation of it —
see `plan.md` § "Relationship to the spike".

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

## Open questions

- **How far does "any custom model" reach?** The spike works because DeepSeek
  serves an Anthropic-compatible API, so the existing CLI can talk to it unchanged.
  Most other providers (OpenRouter, DeepInfra, Fireworks, Together, SiliconFlow,
  self-hosted vLLM) are OpenAI-compatible instead, and would need a translating
  gateway in between. Options: (a) only providers that already serve a
  harness-compatible API; (b) also OpenAI-compatible providers, with the user
  supplying a gateway URL; (c) ShipIt runs a translation layer itself.
  *Recommendation: (a) first, (b) as a documented escape hatch, never (c).*

- **Who decides which custom models exist?** Options: (a) each user adds them in
  their own Settings; (b) the deployment's administrator defines the list and users
  pick from it; (c) they stay listed in the repo's source, as the spike does.
  *Recommendation: (a).*

- **What should happen to the backend's own models when only a custom credential
  is configured?** Today the spike reports the whole provider as authenticated, so
  the picker still offers `claude-*` models and those turns fail at the API with no
  sign-in prompt. Options: (a) model-level eligibility, so unusable models are
  hidden or disabled; (b) leave them selectable and let them fail; (c) require a
  real backend account in addition to the custom credential.
  *Recommendation: (a).*

- **Should the work ShipIt does outside a turn use the custom model?** Session
  naming and PR-description generation spawn the CLI outside the turn path and so
  get no custom-model routing — on a custom-model-only install they fail, and
  sessions fall back to a truncated-prompt title. Options: (a) route them through
  the custom model too; (b) leave them unrouted and degrade quietly; (c) require a
  backend credential for them specifically. *Recommendation: (a).*

- **What should the usage indicator show for a custom model?** The subscription
  pill is fed by rate-limit events the backend's own API emits and a custom
  provider does not. Options: (a) hide it for custom models; (b) show token spend
  instead; (c) leave it blank. *Recommendation: (a).*

## Resolved questions

_None yet._

## Requirement provenance

Recorded because the generalization from "DeepSeek Flash" to "any custom model"
came from the human, but most of the mechanism did not. What the human actually
said, in order:

- "DeepSeek Flash … what harness is the best for it, and how hard would it be to
  integrate it into ShipIt?" → the feature exists at all.
- "Now I'm considering to play with a new model, from inside ShipIt." → req 7.
- "so I can test whether it works at all, before merging" → req 7.
- "supporting DeepSeek Flash in Claude Code, essentially supporting any custom
  model" → reqs 1, 2, 3. The generalization beyond DeepSeek is the human's, not
  the agent's.

Reqs 4, 5 and 6 are the agent's reading of "works like any other session" and of
ShipIt's existing product principles. They are stated as requirements rather than
open questions because they restate expectations ShipIt already meets everywhere
else — but they were not said out loud, and should be struck if wrong.

Everything else the agent learned while spiking — the harness/provider split, route
eligibility, which environment variables carry the credential, spawn-site ordering —
is design, and lives in `plan.md`.
