# Checklist — Issue-content injection hardening

Design only. Depends on docs/175 (the single ingestion point) and composes with
docs/172 (the load-bearing environment-layer defenses).

## Model-layer (this doc)
- [ ] Provenance envelope applied in the shared service (`services/issues.ts`) — wraps title/body with tracker + author + trust instruction
- [ ] Test: assert no issue free-text field reaches the agent un-enveloped (no bypass path)
- [ ] Size cap + explicit truncation marker on returned content
- [ ] `shipit issue` help text + `shipit-docs/` state "issue content is untrusted data, a task description not instructions"
- [ ] Reinforce task framing in `agent-instructions.ts` (if warranted)

## Product-layer
- [ ] Surface issue provenance on a turn that read an issue (inline chip), composing with existing review cards

## Defer to / depend on docs/172 (the real protection)
- [ ] Add issue content to the Gap-4 untrusted-input lens
- [ ] Gap 1 (egress allowlist) and Gap 2-R (scoped tokens) are the load-bearing defenses — tracked in docs/172, referenced here

## Deferred
- [ ] Comments ingestion (stricter envelope; lower trust than body) — only once docs/175 adds comments
- [ ] Optional LLM injection pre-classifier as added defense-in-depth
