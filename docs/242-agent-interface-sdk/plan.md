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
  SDK-specific confirmation solely because the message came from that page.

No requirement was provided for confirmation UI, payload limits, user-gesture
enforcement, message provenance UI, additional surfaces, or SDK capabilities
beyond sending a message. Those remain product/design choices rather than being
silently added to the requirement set.

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
- docs/146 defines the planned cooperative Preview visibility protocol under
  the existing `{ source: "shipit-preview", type: ... }` `postMessage`
  envelope. A page emits `ready`; ShipIt replies with and subsequently publishes
  `visibility` transitions. The first visibility message is authoritative, so a
  cooperating page does not assume that a newly mounted background frame is
  visible.
- `dispatchAgentMessage` in
  `src/client/utils/dispatch-agent-message.ts` owns the browser-side optimistic
  user bubble and calls `POST /api/sessions/:id/agent/dispatch`.
- `dispatchAgentMessage` in
  `src/server/orchestrator/services/agent.ts` resolves the session runner and
  reaches `runner.dispatch(...)`, the shared start-or-queue funnel introduced by
  docs/150. The funnel also participates in the existing programmatic steering
  decision when a turn is already running.

These are implementation foundations, not new requirements.

## Proposed SDK

### Page-facing API

First-version working API:

```ts
interface ShipItSdk {
  /** The runtime exists only when the page is embedded in a supported ShipIt surface. */
  readonly embedded: true;
  readonly visibility: {
    /** Unknown until ShipIt supplies the authoritative initial state. */
    readonly current: boolean | null;
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

The shared runtime also exposes the planned visibility contract. Its presence
and `embedded: true` let a page detect ShipIt without a separate probe. The
visibility state remains `null` until the parent supplies the first
authoritative value; `subscribe` then reports that value and every transition.
An audio application can suspend or resume its own `AudioContext` from that
callback without coupling its code to raw `postMessage` shapes.

### Why an injected global

An injected `window.shipit` global works for both requested surfaces and both
capabilities without requiring an npm dependency, a build step, or a network
import. An agent can
write a self-contained HTML artifact or ordinary application code and feature
detect the host:

```js
if (window.shipit?.embedded) {
  // Running inside a ShipIt surface that supports the bridge.
}
```

The SDK implementation is a small browser-side proxy. It does not contain an
orchestrator URL, session ID, cookie, token, or other authority that the child
page could extract.

## Compatibility with the preview visibility contract

The Agent Interface SDK and docs/146 must be two modules of one page bridge, not
two globals or two unrelated protocols:

```text
window.shipit
   ├─ embedded
   ├─ visibility.current / subscribe()  ← docs/146 ready + visibility
   └─ agent.sendMessage()               ← this design
```

On initialization the shared bootstrap:

1. installs `window.shipit` once;
2. registers one parent-message listener;
3. posts the existing `{ source: "shipit-preview", type: "ready" }` handshake;
4. updates the visibility module for every existing
   `{ source: "shipit-preview", type: "visibility", visible }` message; and
5. correlates agent-message responses without swallowing other
   `shipit-preview` message types.

The visibility module is a convenience wrapper around docs/146, not a replacement
wire contract. Existing pages that implement the raw `ready`/`visibility`
snippet remain compatible. A duplicate `ready` is safe because docs/146 already
requires the parent response to be idempotent.

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

### Host-side frame binding

The child does not supply a `sessionId`. The ShipIt host resolves it from the
surface that received the event:

```text
event.source
   ├─ active Present iframe ──→ presentation's owning session
   └─ active Preview iframe ──→ preview's owning session
```

The listener accepts a request only when `event.source` is the `contentWindow`
of a registered ShipIt iframe. A page opened outside ShipIt has no registered
parent and therefore no working bridge. A page cannot choose or name another
session.

This source binding is the central trust boundary. Checking only the payload's
`source` string would not be sufficient because any browser script can forge
that string.

### Host to agent

After validation, the client calls the existing authenticated dispatch helper
with the host-resolved session ID and the SDK-provided text:

```text
SDK postMessage
  → client frame registry validates source and resolves session
  → dispatchAgentMessage(...)
  → POST /api/sessions/:id/agent/dispatch
  → services/agent.ts validation and session resolution
  → runner.dispatch(...)
  → start, steer, or queue under existing turn rules
```

This deliberately does not add an orchestrator endpoint reachable directly by
the service or artifact. The browser host already has the authenticated session
context; keeping that context out of the child preserves the current iframe
isolation.

## Surface integration

### Present artifacts

`RenderedFrame` should gain an opt-in ShipIt page-bridge mode rather than
enabling the SDK for every HTML file it renders. `PresentPane` enables that mode
and supplies the presentation/session binding; the ordinary file preview leaves
it off.

The enabled renderer injects the SDK bootstrap into `srcDoc` alongside the
existing CSP. `postMessage` remains available inside the origin-null sandbox,
so `allow-same-origin` is neither necessary nor acceptable.

The bridge belongs on the active rendered Present iframe. Markdown, images, and
source mode do not run page JavaScript and therefore do not expose the SDK.

### Service previews

`preview-proxy.ts` should inject the same shared ShipIt bootstrap into HTML
responses next to its existing HMR/navigation patch. This makes both the
visibility wrapper and agent API available to pages served by any Compose
preview without requiring the application to import a ShipIt package. This
supersedes docs/146's need for newly scaffolded applications to hand-copy the
raw listener for detection and visibility; the raw protocol remains supported
for existing pages.

The Preview frame registers its `contentWindow` with the host bridge and binds
it to the active session. A service page loaded directly outside ShipIt's
Preview iframe may still contain the harmless bootstrap, but calls fail because
there is no registered ShipIt parent to answer them.

## Client ownership

A focused client module should own the protocol rather than adding more
one-off message handling to `App.tsx`:

```text
src/client/agent-interface-sdk/
  protocol.ts          shared visibility + agent protocol guards and public TS shape
  bootstrap.ts         dependency-free child-frame ShipIt runtime source
  frame-registry.ts    event.source → session/surface binding
  useAgentInterfaceHost.ts
```

`App.tsx` supplies the authenticated dispatch callback and current-session
connection; the hook owns listener lifecycle, request correlation, validation,
and replies. `PresentPane` and `PreviewFrame` register/unregister their iframe
elements through the frame registry.

The exact file split may change during implementation. The ownership boundary
is the design decision: protocol and frame authorization stay centralized, while
surface components only register their frames.

## SDK distribution

The Present renderer and preview proxy need byte-identical bootstrap code. Keep
one dependency-free source of truth for `embedded`, visibility, and agent
messaging, and produce a string suitable for both injection sites. The build
must not maintain separate visibility and agent bootstraps or two hand-copied
SDK implementations.

One viable implementation is a small TypeScript module that exports the
bootstrap source as a constant, with a test that executes that source in a DOM
fixture. If escaping becomes difficult, a tiny build script can generate the
string; adding a separately versioned npm package is unnecessary for the first
version.

Following docs/146, additive behaviors receive new `type` names under the
`shipit-preview` envelope rather than versioning every message. A future breaking
change adds a new type and preserves the old one during compatibility rollout.

## Failure behavior

The Promise rejects when:

- the page is not hosted in a registered ShipIt surface;
- the payload is malformed or its text is empty;
- the session connection is unavailable;
- ShipIt's authenticated dispatch endpoint rejects the message; or
- no host response arrives before the SDK timeout.

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
- A container restart does not invalidate the API contract. A reloaded page
  receives a fresh bootstrap and binds to the current browser/session frame.
- Each SDK call is independent. The page is not promised a long-lived agent
  process; the call creates, steers, or queues a normal turn under current
  ShipIt behavior.

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

This is a deliberate expansion of the trust gate's current documented scope.
Today docs/178 gates automatic install and Compose execution but permits agent
chat and file inspection while restricted. Implementation and agent-facing docs
must say that page-to-agent SDK access is a trusted-repository capability, so
future changes do not accidentally expose it in restricted mode.

The containment measures proposed by the design are:

- no session ID or credential in the child SDK;
- frame-source binding in the parent;
- a single, schema-validated method;
- no generic fetch or WebSocket bridge;
- no cross-session target supplied by the child;
- no relaxation of the Present iframe sandbox; and
- sanitized errors returned to the child.

The shared runtime also reduces protocol surface: page detection, visibility,
and agent messaging use one injected global and the existing `shipit-preview`
envelope rather than granting multiple bridges.

Whether SDK dispatch must require a live browser user activation, show the exact
message for confirmation, or apply a product-level text-size limit is not
specified by the provided requirements. Those are open product decisions below,
not assumptions made by this design. Repository trust itself is resolved: once
the existing trust gate passes, no additional confirmation is required merely
to establish the page's authority to call the SDK.

## Open product decisions (not requirements)

These questions must be answered before implementation because each changes
observable behavior. They are intentionally not resolved here:

1. **Invocation policy:** after repository trust is established, may page
   JavaScript call `sendMessage` at any time, or only while handling a recent
   user gesture such as a click or submit? This is an interaction-policy choice,
   not a second repository-trust decision.
2. **Confirmation:** after repository trust is established, does ShipIt send
   immediately, or show the composed text for confirmation first? Any such
   confirmation would be message review UX, not a re-prompt to trust the repo.
3. **Transcript presentation:** is the submitted text rendered as an ordinary
   user bubble, or does it carry a visible “from Present/Preview” treatment?
4. **Message bounds:** should the first version impose a product-specific text
   limit beyond the limits already enforced by the agent dispatch path?
5. **Surface scope:** are Present and Preview/service pages the complete initial
   surface list, or should other ShipIt-rendered HTML surfaces opt in too?

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
  bootstrap injection and iframe registration.
- `src/client/components/PresentPane.tsx` — enable and bind the Present surface.
- `src/client/components/PreviewFrame/` — bind the active service iframe.
- `src/client/components/RepoTrustBanner.tsx` and client repo state — authoritative
  browser-side gate for enabling the agent module on repository-backed frames.
- `src/server/orchestrator/repo-store.ts` / trust-aware session lookup —
  authoritative server-side enforcement; never trust a child-provided claim.
- `src/client/agent-interface-sdk/` — protocol, SDK bootstrap, frame registry,
  and host hook.
- `src/client/App.tsx` — provide the existing agent-dispatch callback to the host
  hook.
- `src/server/orchestrator/preview-proxy.ts` — inject the SDK bootstrap into
  proxied HTML.
- `src/server/shipit-docs/agent-interface-sdk.md` — agent-facing SDK reference.
- `src/server/shipit-docs/present.md` and `preview.md` — discovery links.

No new agent runner or queue implementation is expected; the design reuses
docs/150's dispatch funnel.

## Test strategy

Implementation should co-locate tests with each layer:

- protocol guards reject unknown sources/types, empty text, and invalid shapes;
- the shared bootstrap exposes `embedded`, starts visibility at `null`, emits
  the existing `ready` handshake, and updates subscribers from existing
  `visibility` messages;
- raw docs/146 visibility listeners and the SDK wrapper can coexist without
  either swallowing the other's messages;
- the injected SDK correlates concurrent requests and resolves/rejects the
  correct Promise;
- Present exposes the SDK only in rendered HTML mode and retains
  `sandbox="allow-scripts"` without `allow-same-origin`;
- the preview proxy injects the bootstrap once into HTML and not into non-HTML
  responses;
- the host rejects a forged payload from an unregistered `Window`;
- the host binds a valid request to the frame's session rather than accepting a
  child-supplied session target;
- dispatch success produces the normal user-message/turn flow, including the
  busy-runner path; and
- dispatch errors return a correlated, sanitized failure to the page.

An integration test should cover each requested surface end to end:

```text
page SDK call → parent bridge → authenticated dispatch → owning runner
```

## Relationship to existing designs

- `docs/093-agent-present` — Present artifact lifecycle and sandboxed rendering.
- `docs/146-preview-visibility-contract` — the existing page-detection and
  cooperative visibility protocol that the shared SDK wraps and preserves.
- `docs/150-unify-agent-message-dispatch` — shared send/steer/queue funnel.
- `docs/175-preview-services-drawer` — service/debug UI inside the Preview tab.
- `docs/188-present-from-file` — file-backed Present artifacts.
- `docs/207-action-checklist-cards` — precedent for a UI interaction producing
  an agent turn while the agent remains the actor; this SDK generalizes the
  authoring surface beyond a fixed ShipIt card.
