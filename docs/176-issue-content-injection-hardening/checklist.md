# Checklist — Issue-content injection hardening

Design only. Depends on docs/175 (the single ingestion point) and composes with
docs/172 (the load-bearing environment-layer defenses).

## Model-layer (this doc)
- [x] Provenance envelope applied at the agent's text-ingestion point — the
      `shipit issue` shim's `renderIssue`/`renderComments`/list rendering
      (`agent-shim/shipit.ts`) wraps title/body/comments with tracker:identifier
      provenance + a trust instruction, reusing SHI-98's `wrapUntrustedContent`
      (`source: "issue"`). **Note:** the original "in `services/issues.ts`" plan
      no longer fits the architecture — that service is shared with the Issues-tab
      UI and returns structured objects, so wrapping there would corrupt the UI
      and still wouldn't produce the agent's *text*. The shim is the single layer
      that turns issue free-text into the prose the agent reads. See plan §1.
- [x] Test: issue free-text is wrapped, comments lower-trust, forged-marker
      defang, oversized truncation, list wrapped, `--json` structured-not-wrapped
      (`shipit.test.ts`, "Untrusted-input envelope" block)
- [x] Size cap + explicit truncation marker on returned content (`MAX_ISSUE_*`)
- [x] `shipit-docs/issues.md` + `untrusted-input.md` state "issue content is
      untrusted data, a task description not instructions" (envelope documented)
- [x] Task framing already in `agent-instructions.ts` "## Untrusted input"
      (SHI-98) — lists issue-tracker text among the untrusted surfaces; no new
      cache axis needed.

## Product-layer
- [x] Issue provenance surfaced on a read turn — the existing `shipit issue view`
      jump-to-issue card (docs/188) records which issue was read; the envelope's
      `tracker:identifier` provenance makes a steered action attributable. (No new
      chip needed — the read card already composes with the review cards.)

## Defer to / depend on docs/172 (the real protection)
- [x] Add issue content to the Gap-4 untrusted-input lens (the `issue` source of
      SHI-98's `wrapUntrustedContent`)
- [ ] Gap 1 (egress allowlist) and Gap 2-R (scoped tokens) are the load-bearing defenses — tracked in docs/172, referenced here (both merged: SHI-90, SHI-79)

## Deferred
- [x] Comments ingestion (stricter envelope; lower trust than body) — docs/175
      added comments (`--comments`); they inherit the lower-trust envelope here.
- [ ] Optional LLM injection pre-classifier as added defense-in-depth (out of scope, see plan)
