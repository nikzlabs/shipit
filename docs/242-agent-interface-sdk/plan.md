---
issue: https://linear.app/shipit-ai/issue/SHI-272
title: Agent interface SDK
description: Let JavaScript in service previews and presented artifacts compose and send messages to the agent that owns the session.
---

# 242 — Agent interface SDK

## Overview

ShipIt can already render interactive pages in two places relevant to this
feature:

- a running Compose service in the Preview tab; and
- an HTML artifact in the Present tab.

Those pages can collect input, render state, and respond to clicks, but they
cannot currently turn an interaction into a new agent turn. The proposed SDK
closes that loop:

```text
agent creates interface
        ↓
user interacts; page JavaScript gathers values
        ↓
page calls the ShipIt SDK with a composed message
        ↓
ShipIt sends the message to this session's agent
        ↓
agent acts and may update the interface
```

The source requirements are deliberately kept separate in
[requirements.md](./requirements.md). This plan does not treat the additional
design choices below as user requirements.

## Requirement provenance

The requested experience is:

- interactions in service/debug UIs and presented artifacts can message the
  agent for the same ShipIt session;
- the page uses a JavaScript SDK, because its JavaScript may first collect user
  input or other information; and
- this enables an agent to create an interface for itself; and
- the API is compatible with the planned page-visibility feature through which
  a page can detect that it is inside ShipIt and mute itself when not visible;
  and
- for repository-backed pages, the existing **Trust this repository** action is
  the consent that authorizes repository code to use the SDK, without a second
  SDK-specific confirmation solely because the message came from that page; and
- the SDK is a programmatic interface: agent-created tools may invoke the agent
  automatically without a recent click, submit, or other user gesture.

No requirement was provided for payload limits, message provenance UI,
additional surfaces, or SDK capabilities beyond sending a message. Those remain
product/design choices rather than being silently added to the requirement set.

## Product-principle check

This is an alternate input surface for chat, not a command surface. The page
submits intent to the agent; it does not directly run a shell command, operate a
service, mutate files, or invoke arbitrary ShipIt APIs. The agent remains the
actor, and the resulting instruction uses ShipIt's existing agent-turn
machinery.

This distinction keeps the feature aligned with the product principle that chat
is the input surface and the agent is the actor. An interface that exposed
`runCommand()`, `startService()`, or generic authenticated HTTP access would be a
different feature and is outside this design.

## Verified existing foundations

The design relies on the following existing behavior, verified in source:

- `RenderedFrame` in
  `src/client/components/FileContentView/RenderedFrame.tsx` renders Present HTML
  in a `sandbox="allow-scripts"` iframe without `allow-same-origin`. Scripts can
  run, but the artifact cannot read ShipIt cookies, storage, or parent DOM.
- `preview-proxy.ts` already rewrites HTML returned by a service to inject the
  HMR/navigation bootstrap. It is therefore the existing central point at which
  ShipIt can make a small runtime available to proxied service pages.
- The repository trust gate in `RepoTrustBanner.tsx`, `RepoStore`, and
  `service-manager-setup.ts` prevents an untrusted remote from starting its
  install or Compose services. Accepting **Trust this repository** persists
  trust per canonical remote and unblocks repository-authored code execution.
  Current source scopes that gate to automatic command/service execution while
  still allowing chat and file inspection; this design deliberately extends the
  same trust decision to the new page-to-agent capability rather than inventing
  a second consent surface.
- `dispatchAgentMessage` in
  `src/client/utils/dispatch-agent-message.ts` owns the browser-side optimistic
  user bubble and calls `POST /api/sessions/:id/agent/dispatch`.
- `dispatchAgentMessage` in
  `src/server/orchestrator/services/agent.ts` resolves the session runner and
  reaches `runner.dispatch(...)`, the shared start-or-queue funnel introduced by
  docs/150. The funnel also participates in the existing programmatic steering
  decision when a turn is already running.
- `useIframePool.ts` retains as many as 20 live Preview iframes keyed by
  `(sessionId, port)`, including frames from non-active sessions. CSS visibility
  does not stop their JavaScript.
- `usePreviewErrors.ts` already extracts a session from the preview subdomain
  origin and drops messages from non-active sessions. This is the precedent for
  validating Preview bridge traffic; frame identity alone is not sufficient.

These are implementation foundations, not new requirements.

### Planned dependency, not an existing guarantee

docs/146 specifies the cooperative `{ source: "shipit-preview", type: ... }`
`ready`/`visibility` protocol, but its checklist is entirely unimplemented. The
current `PreviewFrame` handles only `loaded`; it does not answer `ready` or emit
visibility transitions.

The SDK's visibility module therefore depends on docs/146's parent behavior
landing first. Implementation order is explicit:

1. implement docs/146's parent-side `ready`/`visibility` contract;
2. introduce the shared injected runtime as a wrapper over that working
   contract; and
3. enable `agent.sendMessage` on the validated active Present/Preview frames.

The agent-message module may be developed independently, but ShipIt must not
publish a visibility API that remains permanently unknown.

## Proposed SDK

### Page-facing API

First-version working API:

```ts
interface ShipItSdk {
  /** False until the parent completes the ShipIt host handshake. */
  readonly embedded: boolean;
  /** Resolves after the host handshake; rejects after a documented timeout. */
  readonly ready: Promise<void>;
  readonly visibility: {
    /** Unknown until ShipIt supplies the authoritative initial state. */
    readonly current: boolean | null;
    /** Immediately reports the current value when it is already known. */
    subscribe(listener: (visible: boolean) => void): () => void;
  };
  readonly agent: {
    sendMessage(input: { text: string }): Promise<{ status: "submitted" }>;
  };
}

declare global {
  interface Window {
    shipit?: ShipItSdk;
  }
}
```

Example interface:

```html
<form id="setup-form">
  <input name="framework" />
  <button>Ask the agent to apply this setup</button>
</form>

<script>
  document.querySelector("#setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await window.shipit.agent.sendMessage({
      text: `Apply this setup:\n${JSON.stringify(values, null, 2)}`,
    });
  });
</script>
```

The page owns data collection and message composition. ShipIt receives only the
final text. The SDK is intentionally narrow in the first version: it does not
expose session lookup, filesystem access, credentials, agent configuration,
permission-mode changes, or arbitrary WebSocket/HTTP calls.

The shared runtime also exposes the planned visibility contract. Injection alone
does not prove embedding: the preview proxy also rewrites a page opened directly
or nested inside another app. `embedded` becomes true only after the registered
ShipIt parent answers the handshake, and `ready` gives asynchronous code an
unambiguous detection primitive. Visibility remains `null` until the parent
supplies the first authoritative value; `subscribe` immediately reports an
already-known value and then every transition.
An audio application can suspend or resume its own `AudioContext` from that
callback without coupling its code to raw `postMessage` shapes.

### Why an injected global

An injected `window.shipit` global works for both requested surfaces and both
capabilities without requiring an npm dependency, a build step, or a network
import. An agent can
write a self-contained HTML artifact or ordinary application code and feature
detect the host:

```js
await window.shipit?.ready;
if (window.shipit?.embedded) {
  // The registered ShipIt parent completed the handshake.
}
```

The SDK implementation is a small browser-side proxy. It does not contain an
orchestrator URL, session ID, cookie, token, or other authority that the child
page could extract.

## Compatibility with the preview visibility contract

Design choice: expose the Agent Interface SDK and docs/146 as two modules of one
page bridge rather than two globals or unrelated protocols. The cost is an
ordering dependency on docs/146; the benefit is one detection/visibility state
machine and one additive message envelope:

```text
window.shipit
   ├─ embedded / ready
   ├─ visibility.current / subscribe()  ← docs/146 ready + visibility
   └─ agent.sendMessage()               ← this design
```

On initialization the shared bootstrap:

1. idempotently installs `window.shipit` once;
2. registers one parent-message listener;
3. posts the existing `{ source: "shipit-preview", type: "ready" }` handshake;
4. updates the visibility module for every existing
   `{ source: "shipit-preview", type: "visibility", visible }` message; and
5. correlates agent-message responses without swallowing other
   `shipit-preview` message types.

The visibility module is a convenience wrapper around docs/146, not a replacement
wire contract. Raw app-authored `ready`/`visibility` listeners remain compatible.
A duplicate `ready` is safe because docs/146 requires the parent response to be
idempotent.

The SDK must preserve docs/146's visibility semantics: visibility describes
whether the ShipIt surface is on screen, not merely whether the browser tab is
foregrounded, and `null` is the safe initial state until the parent replies. The
page remains responsible for deciding how to pause, mute, or throttle itself.

## Transport design

### Child frame to ShipIt host

The injected SDK adds an agent-message type under docs/146's existing
`shipit-preview` `postMessage` envelope:

```ts
interface AgentSdkRequest {
  source: "shipit-preview";
  type: "agent_message";
  requestId: string;
  payload: { text: string };
}
```

The ShipIt client sends a correlated response to that same frame:

```ts
type AgentSdkResponse = {
  source: "shipit-preview";
  type: "agent_message_result";
  requestId: string;
} & (
  | { ok: true; status: "submitted" }
  | { ok: false; error: string }
);
```

The response allows page code to show its own success or error state. The
proposed status means ShipIt accepted the message into the normal dispatch
flow; it does not claim that the agent completed the requested work.

The bootstrap posts to `window.parent`, never `window.top`. A nested iframe then
talks only to its immediate application parent and times out harmlessly; it
cannot jump across an inner ShipIt UI into an outer dogfooding session. A
top-level/directly-opened preview rejects immediately because
`window.parent === window`. Child-to-parent posting uses the expected parent
origin when it can be derived and does not send user-composed text with an
unconditional `"*"` target.

### Host-side frame binding

The child does not supply a `sessionId`. The ShipIt host resolves it from the
surface that received the event:

```text
event.source
   ├─ active Present iframe ──→ presentation's owning session
   └─ active Preview iframe ──→ preview's owning session
```

Each surface accepts a request only when all of the following hold:

1. `event.source` equals the live `contentWindow` of that surface's iframe
   element at event time;
2. `event.origin` equals the expected Preview URL origin, or is `"null"` for the
   sandboxed Present `srcDoc` frame;
3. for Preview, the slot key's session equals the currently active ShipIt
   session and the slot is the active visible slot; and
4. the payload passes the shared schema guard.

The exact-origin check closes the stable-`WindowProxy` navigation hole: a
Preview frame that navigates to another origin keeps the same `contentWindow`
identity but loses its authority. Reuse/refactor the existing origin extraction
from `usePreviewErrors.ts`; do not trust a child-supplied session ID.

Background Preview slots are rejected even though their JavaScript remains
alive. The current optimistic dispatch helper writes to the single active
transcript store and receives echoes only for the active session, so accepting a
background request would corrupt the visible session's bubble/loading state.
Supporting autonomous background-session interfaces would require a different
multi-session dispatch UX and is outside the stated requirement.

### Host to agent

After validation, the client calls the existing authenticated dispatch helper
with the host-resolved session ID and the SDK-provided text:

```text
SDK postMessage
  → owning surface validates source + origin + active session
  → dispatchAgentMessage(...)
  → POST /api/sessions/:id/agent/dispatch
  → services/agent.ts validation and session resolution
  → runner.dispatch(...)
  → busy-turn behavior selected by the open product decision below
```

This deliberately does not add an orchestrator endpoint reachable directly by
the service or artifact. The browser host already has the authenticated session
context; keeping that context out of the child preserves the current iframe
isolation.

## Surface integration

### Present artifacts

`RenderedFrame` should gain an opt-in ShipIt page-bridge mode and an iframe-ref
callback rather than enabling the SDK for every HTML file it renders. The prop
threads through `FileContentView` from `PresentPane`, which owns the active
artifact/session binding. Ordinary file preview, `PresentGallery` thumbnails,
and `DiffMediaView` explicitly leave the bridge off.

The enabled renderer injects the SDK bootstrap into `srcDoc` alongside the
existing CSP. `postMessage` remains available inside the origin-null sandbox,
so `allow-same-origin` is neither necessary nor acceptable.

The bridge belongs on the active rendered Present iframe. Markdown, images, and
source mode do not run page JavaScript and therefore do not expose the SDK.

### Service previews

`preview-proxy.ts` should inject the same shared ShipIt bootstrap into HTML
responses next to its existing HMR/navigation patch. This makes both the
visibility wrapper and agent API available to ordinary Compose preview pages
without requiring the application to import a ShipIt package. Applications with
restrictive script CSP require the CSP-compatible delivery described below. This
supersedes docs/146's need for newly scaffolded applications to hand-copy the
raw listener for detection and visibility; the raw protocol remains supported
for existing pages.

`PreviewFrame` already owns the iframe pool, slot keys, active slot, and live
element refs. It handles bridge requests in its existing window-message
listener and delegates the validated payload to a shared request handler. A
service page loaded directly or as a nested iframe may contain the bootstrap,
but never completes the host handshake.

## Client ownership

A small shared module owns protocol parsing/bootstrap generation, while each
surface retains authority over its own frame:

```text
src/server/shared/agent-interface-sdk/
  protocol.ts          request/response guards and public shapes
  bootstrap.ts         dependency-free child-frame runtime source

src/client/agent-interface-sdk/
  handle-request.ts    common validated-request → dispatch/reply behavior
```

`PreviewFrame` and `PresentPane` match `event.source` against their own live
elements, verify their own expected origins and active state, then call the
shared handler. This removes a global frame registry, registration lifecycle,
LRU-eviction synchronization, and stale-ref cleanup. `App.tsx` only supplies the
authenticated dispatch callback.

## SDK distribution

The Present renderer and preview proxy need byte-identical bootstrap code. Keep
one dependency-free source of truth for embedding detection, visibility, and agent
messaging, and produce a string suitable for both injection sites. The build
must not maintain separate visibility and agent bootstraps or two hand-copied
SDK implementations.

One viable implementation is a small TypeScript module that exports the
bootstrap source as a constant, with a test that executes that source in a DOM
fixture. If escaping becomes difficult, a tiny build script can generate the
string; adding a separately versioned npm package is unnecessary for the first
version.

The bootstrap is document-idempotent (`if (window.shipit) return`) because the
proxy can encounter multiple `text/html` responses and fragments. Proxy
injection also has to account for application CSP: the current inline HMR patch
is blocked by restrictive `script-src` policies, so the SDK cannot claim
universal availability until implementation either serves an allowed same-origin
bootstrap or deliberately adjusts CSP with a stable hash/nonce. Tests cover a
restrictive-CSP response, not only ordinary HTML.

Following docs/146, additive behaviors receive new `type` names under the
`shipit-preview` envelope rather than versioning every message. A future breaking
change adds a new type and preserves the old one during compatibility rollout.

## Failure behavior

The Promise rejects when:

- the page does not complete a handshake with an authorized active ShipIt
  surface;
- the payload is malformed or its text is empty;
- the session connection is unavailable;
- ShipIt's authenticated dispatch endpoint rejects the message; or
- no host response arrives within the documented handshake/request timeout.

Errors returned to the child should be useful but should not expose internal
paths, credentials, stack traces, or session metadata. The ShipIt host also
surfaces a normal toast when dispatch fails, matching existing
`dispatchAgentMessage` behavior.

These failure semantics are design choices needed to make the Promise usable;
they are not additional user requirements.

## Agent-facing documentation

Implementation must update the in-container documentation so agents can create
interfaces that use the SDK. A new `/shipit-docs/agent-interface-sdk.md` should
cover:

- where the SDK is available;
- feature detection;
- the visibility state and subscription API, including the authoritative
  initial-state rule and an audio-muting example;
- the `sendMessage({ text })` signature and Promise behavior;
- a form example that collects values before composing the message; and
- the fact that the call produces another agent turn rather than directly
  operating the system.

The Present documentation should link to it. The preview documentation should
mention it where service-page behavior is described.

## Compatibility and lifecycle

- Existing artifacts and services that never call the SDK behave unchanged.
- A presented HTML file remains a normal self-contained file. The injected SDK
  exists only at render time and does not modify the file on disk.
- A service application's source and built output remain unchanged. Injection
  happens in the preview proxy's HTML response.
- A background Preview slot remains mounted but is not authorized to send agent
  messages. Returning to that session/port makes the slot active and restores
  authority without reloading it.
- A container restart does not invalidate the API contract. A reloaded page
  receives a fresh bootstrap and binds to the current browser/session frame.
- Each SDK call is independent. The page is not promised a long-lived agent
  process; accepted work follows the explicit busy-agent policy selected below.

## Security analysis

Repository-authored service pages already run only after the user accepts
ShipIt's one-time **Trust this repository** gate. For this feature, that trust
decision also authorizes the repository's rendered page code to request that the
owning ShipIt client submit text to the owning session's agent. The SDK does not
add a second confirmation solely to re-ask whether that repository is trusted.

The host must enforce the same trust state rather than relying on the fact that a
service usually cannot start before trust. This keeps the rule explicit and
also covers persisted/background frames during transitions. A repository-backed
Present artifact receives the agent module only when its owning remote is
trusted. Sessions with no remote and ShipIt-template repositories follow the
existing trust-gate rule and are trusted by construction.

The repository messaging trust gate is now an existing server-side invariant,
implemented separately in docs/243. SDK submissions must use that shared
dispatch path rather than implementing a second or client-only trust check.

The containment measures proposed by the design are:

- no session ID or credential in the child SDK;
- live frame-source **and exact-origin** binding in the owning surface;
- active-session/active-slot enforcement for pooled Preview frames;
- `window.parent` rather than `window.top`, preserving nested ShipIt boundaries;
- a single, schema-validated method;
- no generic fetch or WebSocket bridge;
- no cross-session target supplied by the child;
- no relaxation of the Present iframe sandbox; and
- sanitized errors returned to the child.

The shared runtime also reduces protocol surface: page detection, visibility,
and agent messaging use one injected global and the existing `shipit-preview`
envelope rather than granting multiple bridges.

The existing server dispatch path already bounds text at 50,000 characters, so
the SDK inherits that limit and does not invent another. The user requirements
also name Present and Preview/service pages as the initial surfaces; other HTML
renderers remain off. Repository trust itself is resolved: once the existing
trust gate passes, no additional confirmation is required merely to establish
the page's authority to call the SDK.

## Resolved product decisions

### Programmatic invocation

SDK calls do not require a recent user gesture and do not show a mandatory
confirmation before sending. Automatic invocation is part of the intended
agent-created-tool capability, including calls from load, timer, and other
asynchronous application logic. Repository trust supplies consent; the shared
server dispatch gate supplies authorization.

The host still restricts authority to the validated active Preview or Present
frame. That is a surface-ownership boundary, not a user-gesture proxy.

## Open product decisions (not requirements)

These questions must be answered before implementation because each changes
observable behavior. They are intentionally not resolved here:

1. **Transcript presentation:** render the SDK instruction as a normal user
   bubble with a Present/Preview source badge, as an indistinguishable plain user
   message, or as a dedicated interface-action card.
2. **Busy-agent behavior:** always queue the SDK request as its own next turn;
   honor live steering and inject when supported; or reject while busy. Current
   `runner.dispatch` calls are steerable unless marked otherwise, so this choice
   must be encoded explicitly rather than inherited accidentally.

These are candidate requirements only if the user chooses them. Until then,
implementation should not silently decide them.

## Rejected alternatives

### Direct orchestrator API from the child page

Rejected. It would require exposing authenticated session authority to untrusted
page code or designing a second token system. The parent bridge already has the
necessary context and keeps the authority outside the child.

### Declarative `data-shipit-message` buttons only

Rejected as the primary API. It cannot satisfy the stated need for page
JavaScript to collect input or other information before composing the message.
A declarative helper could be added later on top of the SDK without changing the
protocol.

### Direct service/file operations

Rejected. They turn the interface into a command runner and bypass the agent,
which conflicts with ShipIt's product model and is unnecessary for the requested
experience.

### A separately installed npm SDK

Rejected for the initial design. It would not naturally cover self-contained
Present artifacts, introduces package/version coordination, and provides no
security benefit over an injected host bridge.

## Implementation touchpoints

Expected touchpoints, subject to the open product decisions:

- `src/client/components/FileContentView/RenderedFrame.tsx` — opt-in Present SDK
  bootstrap injection and iframe-ref callback.
- `src/client/components/FileContentView/FileContentView.tsx` — thread the
  Present-only opt-in; ordinary file preview remains off.
- `src/client/components/PresentPane.tsx` — enable and bind the Present surface.
- `src/client/components/PresentGallery.tsx` and `DiffMediaView.tsx` — explicit
  non-enabled `RenderedFrame` call sites.
- `src/client/components/PreviewFrame/PreviewFrame.tsx` — validate and handle
  requests for the active slot using its existing refs/session ownership.
- `src/client/components/RepoTrustBanner.tsx` and client repo state — authoritative
  browser-side gate for enabling the agent module on repository-backed frames.
- `src/server/orchestrator/repo-store.ts` / trust-aware session lookup —
  authoritative server-side enforcement; never trust a child-provided claim.
- `src/server/shared/agent-interface-sdk/` — shared protocol and bootstrap used
  by the server proxy and client surfaces.
- `src/client/agent-interface-sdk/handle-request.ts` — common dispatch/reply
  behavior after a surface has authorized the frame.
- `src/client/App.tsx` — provide the existing agent-dispatch callback.
- `src/server/orchestrator/preview-proxy.ts` — inject the SDK bootstrap into
  proxied HTML.
- `src/server/shipit-docs/agent-interface-sdk.md` — agent-facing SDK reference.
- `src/server/shipit-docs/present.md` and `preview.md` — discovery links.

No new agent runner or queue implementation is expected; the design reuses
docs/150's dispatch funnel.

## Test strategy

Implementation should co-locate tests with each layer:

- protocol guards reject unknown sources/types, empty text, and invalid shapes;
- the shared bootstrap starts `embedded=false`/visibility `null`, resolves
  `ready` only after the host handshake, immediately reports a known visibility
  value to new subscribers, and is idempotent on duplicate installation;
- raw docs/146 visibility listeners and the SDK wrapper can coexist without
  either swallowing the other's messages;
- the injected SDK correlates concurrent requests and resolves/rejects the
  correct Promise;
- Present exposes the SDK only in rendered HTML mode and retains
  `sandbox="allow-scripts"` without `allow-same-origin`;
- the preview proxy injects the bootstrap once into HTML and not into non-HTML
  responses, with explicit restrictive-CSP coverage;
- a top-level page rejects immediately, a nested page cannot reach
  `window.top`, and ShipIt-in-ShipIt binds to the immediate host only;
- Present accepts only its active origin-null `srcDoc` frame; gallery, diff, and
  ordinary file-render frames cannot send;
- Preview requires both the active slot's live `contentWindow` and exact expected
  origin, rejects navigated frames, and drops background-session/port slots;
- the host derives the frame's session rather than accepting a child-supplied
  session target;
- dispatch success produces the normal user-message/turn flow, including the
  busy-runner path; and
- dispatch errors return a correlated, sanitized failure to the page.

An integration test should cover each requested surface end to end:

```text
page SDK call → parent bridge → authenticated dispatch → owning runner
```

## Relationship to existing designs

- `docs/093-agent-present` — Present artifact lifecycle and sandboxed rendering.
- `docs/146-preview-visibility-contract` — the planned page-detection and
  cooperative visibility protocol that must land before the shared SDK wraps
  and preserves it.
- `docs/150-unify-agent-message-dispatch` — shared send/steer/queue funnel.
- `docs/175-preview-services-drawer` — service/debug UI inside the Preview tab.
- `docs/188-present-from-file` — file-backed Present artifacts.
- `docs/207-action-checklist-cards` — precedent for a UI interaction producing
  an agent turn while the agent remains the actor; this SDK generalizes the
  authoring surface beyond a fixed ShipIt card.
