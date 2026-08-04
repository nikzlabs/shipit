# Preview visibility contract — checklist

> Implemented as part of docs/242 through the shared `window.shipit` runtime.
> The earlier template-snippet tasks were superseded by runtime injection and
> the agent-facing SDK reference; this checklist records the shipped outcomes.

## Runtime and parent contract

- [x] Preserve the raw `{ source: "shipit-preview", type: "ready" }` handshake
- [x] Preserve the raw `{ source: "shipit-preview", type: "visibility", visible }` response
- [x] Expose `window.shipit.visibility.current` with `null` as the pre-handshake state
- [x] Expose `visibility.subscribe()` with immediate delivery of an already-known value
- [x] Reply to Preview `ready` messages with authoritative active-slot visibility
- [x] Emit visibility transitions while persistent Preview frames become active or hidden
- [x] Buffer the iframe-ref race with bounded capacity and expiry
- [x] Keep existing raw listeners compatible alongside the SDK wrapper
- [x] Inject the runtime exactly once into HTML responses

## Surface integration and safety

- [x] Validate the live iframe source and exact expected Preview origin
- [x] Keep background Preview slots mounted but report them as hidden
- [x] Report active rendered Present HTML as visible and inactive/source/gallery states as hidden
- [x] Preserve Present's opaque-origin `sandbox="allow-scripts"` isolation
- [x] Keep nested ShipIt communication bound to `window.parent`, never `window.top`

## Documentation and verification

- [x] Document feature detection, visibility subscription, and pausing audio/animation in `/shipit-docs/agent-interface-sdk.md`
- [x] Link the SDK reference from `/shipit-docs/preview.md` and `/shipit-docs/present.md`
- [x] Add direct SDK discovery pointers to the live-preview instructions and platform-doc index
- [x] Cover bootstrap handshake/state, visibility transitions, source/origin validation, injection idempotence, and raw-protocol compatibility in affected tests
- [x] Run affected tests, `npm run lint:dev`, and `npm run typecheck`
