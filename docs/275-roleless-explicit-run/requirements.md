---
issue: planning#441
title: Role-less explicit run completeness — requirements
description: A role-less `shipit agent run` works whenever the caller names every parameter that exists for the named harness — including on a harness that declares no reasoning levels.
---

# 275 — Role-less explicit run completeness: requirements

**These are the things this feature changes. Everything ShipIt already does is a
requirement too, and is not restated here** — in particular docs/261's role rules and
docs/264's role overrides must keep working exactly as they do today.

This feature exists because the explicit spawn path — docs/261 req 7's "a one-shot agent
run names everything it runs on" — defines "everything" as a fixed list of five flags,
reasoning level included. A harness that declares **no** reasoning levels (Grok, docs/274
req 8) therefore has no expressible explicit target at all: the call is refused for
omitting `--effort`, and there is no value the flag could carry that would be true about
the harness. docs/274's plan recorded this as its "one deliberate limitation"; the Phase 10
verification run (2026-08-18) then hit it as a structural blocker for the
"`shipit agent run` both directions" item, since the sanctioned alternative — a grok role —
does not exist on the install being verified.

No open questions remain.

## Requirements

1. **A `shipit agent run` that names no role works when the caller specifies all
   parameters.** This is the ask, verbatim: "need to make 'shipit agent run' work without
   a role if all parameters are specified."

2. **"All parameters" means every parameter that exists for the named harness.** The
   harness, the service, the billing mode and the model always exist (docs/261 reqs 3
   and 7 — the triple is what identifies a model). The reasoning level exists exactly
   where the harness declares reasoning levels. A harness that declares none has no level
   parameter to name, so a call naming the other four is complete — a complete target must
   not require a value that cannot exist.

3. **A named parameter is never silently dropped, so a level named on a harness that
   declares none is refused by name**, with the remedy (omit the flag) — the same rule the
   role path already applies (docs/264: "naming a level on a harness that declares none
   stays a refusal"). Accepting the flag and dropping it would run something other than
   what was asked for.

4. **An incomplete role-less call stays refused**, naming the parameters it is missing.
   Nothing is filled in from a stored setting, a default, or the session. This is
   docs/261 req 7 unchanged — this feature widens what counts as *complete*, not what
   happens to an incomplete call.

5. **Both spawn commands accept the same targets** (docs/264 req 16). The widened
   completeness rule reaches `shipit session create`'s explicit path through the same
   parser, so a complete role-less target means the same thing on either command.

6. **The discovery and refusal surfaces state the per-harness shape.** `shipit agent
   params` says, for each harness, whether `--effort` is part of a complete call or must
   be omitted; the refusals match, so a caller is never told to supply a flag the harness
   cannot take, or left guessing why one was rejected.

7. **What the CLI accepts and who may assemble it stay two different rules.** This
   feature changes what the platform *accepts*: a complete role-less target validates and
   runs. Which callers are *allowed* to assemble one — the user's instruction or
   repository policy, never the agent's own invention — remains the agent-facing
   prompt-side rule it is today ("pass a complete target through unchanged; never assemble
   one yourself"), and this feature does not weaken it.

## Scope

The role path (docs/261, docs/264) is untouched: a bare role, a role with overrides, and
the reviewer ranking all behave as they do today. The child-session inherit path keeps
docs/261 req 10's rules. Grok subscription-mode reasoning (whether real levels exist
there) stays planning#435's question; if it lands levels for Grok, req 2 makes `--effort`
part of a complete Grok target automatically, with nothing here to revisit.

## Open questions

_None._

## Resolved questions

- 2026-08-18 — **Does "all parameters" include the service and billing mode?** Resolved
  from docs/261 req 3/req 7 rather than asked: a model is identified by the
  (service, billing mode, model) triple, so the explicit five (now "four plus effort where
  it exists") already included them, and this feature does not change that set.
- 2026-08-18 — **Refuse or default-fill a partial role-less call?** Resolved from
  docs/261 req 7's receipts rather than asked: refusal is the existing, deliberate rule
  ("an incomplete call is refused rather than completed from somewhere the caller cannot
  see"), and re-opening it would re-create the invention problem the role rule exists to
  prevent. Req 4 restates it.
- 2026-08-18 — **Refuse or ignore `--effort` on a no-levels harness?** Resolved from the
  role path's shipped rule rather than asked: `roles.ts` already refuses a level named on
  a harness that declares none ("the claim is false about the harness"), and the explicit
  path adopting the same rule is consistency, not a new decision. Req 3.

## Requirement provenance

The ask arrived through the orchestrating parent session, relaying the human verbatim:
"need to make 'shipit agent run' work without a role if all parameters are specified"
→ req 1. The tasking's stated constraints: "a complete grok target must not require an
effort that cannot exist" → req 2; "refuse loudly, never fill gaps from defaults" →
req 4; "the softening is about what the CLI ACCEPTS; which callers are ALLOWED to
assemble one stays a prompt-side rule — keep the two layers distinct" → req 7. Reqs 3, 5
and 6 are the agent's, derived respectively from the shipped role-path rule, docs/264
req 16, and docs/264 req 12's "you can only name what you can see" — each cited where
derived, none from a human answer.
