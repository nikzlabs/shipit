---
issue: planning#512
title: Contained builds
description: What a Dockerfile build step run by ShipIt must and must not be able to reach.
---

# Contained builds

1. A Dockerfile build step that ShipIt runs on behalf of repository or plugin
   content must reach no destination that the same content could not reach at
   run time, in the same session.
2. A build step must not reach the deployment host's own network position —
   host loopback services, and the host's link-local addresses such as the
   cloud instance metadata endpoint — which no session container can reach.
3. Containment must be active before the build's first instruction runs. There
   must be no window in which any build instruction executes uncontained.
4. A contained build must still be able to install software from an allowed
   host. Containment must not turn every build into an offline build.
5. The build definition must not be able to weaken, widen, or opt out of the
   containment. This covers the Dockerfile, the compose file, and build
   arguments, and it covers the identity a build step chooses to run as.
6. If ShipIt cannot contain a build, it must refuse to run the build rather
   than run it uncontained, and must say why it refused. A build that is run
   differently instead — offline, or with a narrowed policy — is not a refusal.
7. When a build fails because a destination is not allowed, the user must learn
   which host was blocked, and must be able to allow that host through the same
   Settings → Network path used for every other blocked host.
8. An Open session, or a deployment with egress enforcement explicitly
   disabled, keeps today's build behaviour. Requirements 1–7 apply only where
   enforcement applies.

## Open questions

- **Whose allowlist governs a build?** The triggering session's effective
  allowlist, including grants that session's user has just made, or a single
  instance-level build allowlist? *Recommendation:* the session's effective
  allowlist, which is what `plugin-egress.ts` already does for plugin CLI and
  install containers. Consequence to accept: what a build could fetch then
  depends on which session ran it, so whether a built image may be reused by a
  different session becomes a decision for planning#510 rather than a free one.
- **Are non-exec fetches build egress?** A base image pull (`FROM`), an
  `ADD <url>`, a remote git context, and a registry token request are not made
  by a build step — the first three are made by the builder and the last can be
  made by the build *client*. Today none of them is subject to any policy. Does
  requirement 1 cover them? *Recommendation:* yes, with the container
  registries on the standard base list so an ordinary `FROM` keeps working
  without a grant. Answering this needs the client-side token path in
  `plan.md` covered or explicitly excluded.
- **Does requirement 1 apply to a project's own repository in the first
  increment?** A project whose Dockerfile fetches from a host that is not on
  the allowlist starts failing, with the host named and a grant available. Is
  that acceptable, or should only plugin-supplied builds be contained at first,
  with project builds kept on today's behaviour until the user opts in?
- **What happens at the moment a build is blocked?** Fail the build and name
  the host, or offer the same allow-once decision the agent gets, which means
  an interactive decision in the middle of a build. *Recommendation:* fail and
  name the host first; the user re-runs after granting.
- **What may a contained build stop being able to do?** Some candidate
  mechanisms permit any protocol to an allowed address; others route the build
  through an HTTPS-inspecting proxy, which blocks raw TCP and `git://`, and
  also breaks a build that pins a certificate or uses its own trust store
  rather than the system one. This is a capability question about builds, not a
  mechanism question, so it belongs here.
- **Is a session-driven `docker build` in scope?** A session with Docker access
  can `POST /build` through ShipIt's Docker proxy (`docker-proxy.ts`), which is
  the same gap through a different door. Does requirement 1 cover that path in
  this feature, or only the builds ShipIt itself invokes?
- **What may a contained build cost?** Containment adds infrastructure per
  policy scope and a cache that has to live somewhere. What is the acceptable
  ceiling in added first-build time, in added warm-build time, and in disk?

## Provenance of the requirements above

Requirements 1–8 are written from the brief that opened this work, which
relayed the need; they have not been through a human review pass, and the open
questions above are the parts that were not supplied. The two notes below
record what that brief settled, and are not fresh human decisions.

- 2026-09-05 — Why now, when the gap is documented and was deliberately left
  open by docs/263-compose-service-egress? Because a plugin repository's new
  commits execute under a standing grant without further review
  (docs/262-plugins req 19), and `plugin-egress.ts` already goes to the length
  of a pre-contained holder container so plugin code never has one uncontained
  instant. A plugin Dockerfile that ShipIt builds would hand that same plugin
  more reach than its own CLI container gets. Constraint carried: containment
  for a build must be at least as strong as containment for the CLI the build
  produces.
- 2026-09-05 — Is a hardware isolation boundary in scope?
  docs/264-docker-sandboxes-evaluation deferred that, and its recorded trigger
  names repo-declared BuildKit builds. It stays deferred: this feature is about
  what a build can reach on the network, and buys no kernel boundary. See
  *Residual risk* in `plan.md` for what that leaves open.
