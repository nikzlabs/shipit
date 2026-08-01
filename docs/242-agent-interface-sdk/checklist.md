# Agent interface SDK — implementation checklist

## Design and dependencies

- [x] Keep user-provided requirements separate in `requirements.md`
- [x] Resolve invocation policy: allow programmatic calls without a user gesture
- [x] Resolve transcript presentation: normal user bubble with a Preview/Present badge
- [x] Require agent-visible, host-owned SDK provenance
- [x] Reuse existing UI start/live-steer/queue dispatch behavior
- [x] Verify the repository messaging trust gate is present on `origin/main`
- [x] Reconcile every implementation touchpoint against current source before editing

## Shared page runtime and visibility

- [x] Add shared, dependency-free protocol types and schema guards
- [x] Add an idempotent `window.shipit` bootstrap with `embedded`, `ready`, visibility state, and `agent.sendMessage`
- [x] Preserve the existing raw `shipit-preview` `ready`/`visibility` wire contract
- [ ] Correlate concurrent SDK request promises by stable request ID
- [ ] Reject direct/top-level use and time out an unanswered host handshake
- [x] Inject the runtime exactly once into proxied HTML and never into non-HTML responses
- [ ] Define and test behavior under restrictive Content Security Policy
- [x] Implement Preview's authoritative initial visibility reply and hide/show transitions
- [x] Cover the iframe-ref race without weakening source/origin validation

## Preview and Present host bridges

- [ ] Accept requests only from the active Preview slot's live `contentWindow` and exact expected origin
- [ ] Reject cached background slots, cross-session slots, and navigated frames
- [ ] Enable the SDK only for the active rendered Present HTML iframe
- [ ] Keep Present's `sandbox="allow-scripts"` isolation unchanged
- [ ] Keep ordinary file rendering, gallery thumbnails, diffs, and non-HTML Present content SDK-disabled
- [ ] Derive the owning session and `preview`/`present` provenance in the host; never accept either from the child
- [ ] Return correlated, sanitized success or failure responses to the originating frame
- [ ] Route accepted requests through the existing authenticated dispatch helper and runner trust gate

## Transcript and agent provenance

- [ ] Add typed persisted provenance for `agent_interface_sdk` plus Preview/Present surface
- [ ] Render SDK instructions as normal user bubbles with a source badge
- [ ] Keep optimistic append, server echo, queue movement, reload, and reconnect deduplication provenance-safe
- [ ] Ensure transcript-scoped events carry and filter by the owning session ID
- [ ] Add a deterministic ShipIt-authored SDK/surface wrapper to the agent input
- [ ] Keep the page-authored text unchanged and clearly delimited inside the agent-visible wrapper
- [ ] Derive the badge and agent wrapper from the same host-owned metadata
- [ ] Preserve existing idle, live-steer, and queued dispatch semantics

## Agent-facing documentation

- [ ] Add `/shipit-docs/agent-interface-sdk.md` with API, detection, automatic invocation, errors, and examples
- [ ] Link the SDK reference from Present and Preview documentation
- [ ] Document visibility-driven audio, media, animation, and timer pausing
- [ ] State that repository trust authorizes SDK messages and that the server enforces it
- [ ] Document source-badged transcript and agent-visible provenance behavior

## Tests and completion

- [ ] Unit-test protocol validation, bootstrap idempotence, handshake, visibility, timeout, and request correlation
- [ ] Unit-test Preview and Present source/origin/active-frame authorization (Preview source/origin covered; Present pending)
- [ ] Test trusted, untrusted, no-remote, and template dispatch controls through the SDK path
- [ ] Test idle start, enabled live steering, and queue fallback
- [ ] Test transcript persistence and reload/reconnect behavior with both surface badges
- [ ] Add end-to-end coverage for Preview and Present SDK call → host bridge → owning runner
- [ ] Verify raw visibility listeners coexist with `window.shipit`
- [ ] Run `npm run test:dev`
- [ ] Run `npm run lint:dev`
- [ ] Run `npm run typecheck`
- [ ] Run `bash .claude/skills/docs-navigator/index.sh` and confirm docs/242 is discoverable with a checklist
- [ ] Update `plan.md` key files and mark all completed checklist items
