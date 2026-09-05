---
issue: planning#512
title: Contained builds
description: What a Dockerfile build step run by ShipIt must and must not be able to reach.
---

# Contained builds

1. A Dockerfile build step that ShipIt runs on behalf of repository or plugin
   content must reach no destination that the same content could not reach at
   run time, in the same session, under that session's egress policy.
2. A build step must not reach the deployment host's own network position —
   host loopback services and link-local addresses such as the cloud instance
   metadata endpoint — which no session container can reach today.
3. Containment must be active before the build's first instruction runs. There
   must be no window in which any build instruction executes uncontained.
4. A contained build must still be able to install software from an allowed
   host. Containment must not turn every build into an offline build.
5. The build definition must not be able to weaken, widen, or opt out of the
   containment. This covers the Dockerfile, the compose file, and build
   arguments, and it covers the identity a build step chooses to run as.
6. If ShipIt cannot contain a build, it must refuse to run the build rather
   than run it uncontained, and must say why it refused.
7. When a build fails because a destination is not allowed, the user must learn
   which host was blocked, and must be able to allow that host through the same
   Settings → Network path used for every other blocked host.
8. An Open session, or a deployment with egress enforcement explicitly
   disabled, keeps today's build behaviour.

## Open questions

- **Whose allowlist governs a build?** The triggering session's effective
  allowlist, including grants that session's user has just made, or a single
  instance-level build allowlist? *Recommendation:* the session's effective
  allowlist, which is what `plugin-egress.ts` already does for plugin CLI and
  install containers. Consequence to accept: what a build could fetch then
  depends on which session ran it, so whether a built image may be reused by a
  different session becomes a decision for planning#510 rather than a free one.
- **Are non-exec fetches build egress?** A base image pull (`FROM`), an
  `ADD <url>`, and a remote git context are fetched by the builder itself, not
  by a build step. Today they leave the daemon with no policy at all. Under
  requirement 1 they are build egress. *Recommendation:* yes, subject to the
  same allowlist, with the container registries on the standard base list so
  that an ordinary `FROM` keeps working without a grant.
- **May contained builds break existing project Dockerfiles?** A project whose
  Dockerfile fetches from a host that is not on the allowlist starts failing,
  with the host named and a grant available (requirement 7). Is that acceptable
  for a project's own repository, or must project builds keep today's behaviour
  until the user opts in, with only plugin-supplied builds contained at first?
- **What happens at the moment a build is blocked?** Fail the build and name
  the host, or offer the same allow-once decision the agent gets, which means
  an interactive decision in the middle of a build. *Recommendation:* fail and
  name the host first; the user re-runs after granting.
- **Must non-HTTP(S) egress from a build keep working?** A build that opens a
  raw TCP connection, or uses `git://`, is not an HTTP request. Some candidate
  mechanisms permit it to an allowed address and some block everything that is
  not HTTP(S). This decides between them, so it is a capability question rather
  than a mechanism one.
- **Is a session-driven `docker build` in scope?** A session with Docker access
  can `POST /build` through ShipIt's Docker proxy
  (`docker-proxy.ts`), which is the same gap through a different door. Does
  requirement 1 cover that path in this feature, or only the builds ShipIt
  itself invokes?
- **What may a contained build cost?** Containment adds at least one resident
  builder container per policy scope plus its build-cache volume. What is the
  acceptable ceiling in added first-build time and in disk?

## Resolved questions

- 2026-09-05 — Why now, when the gap is documented and was deliberately left
  open by docs/263-compose-service-egress? Because a plugin repository's new
  commits execute under a standing grant without further review
  (docs/262-plugins req 19), and `plugin-egress.ts` already goes to the length
  of a pre-contained holder container so plugin code never has one uncontained
  instant. A plugin Dockerfile that ShipIt builds would hand that same plugin
  more reach than its own CLI container gets. Constraint carried:
  containment for a build must be at least as strong as containment for the
  CLI the build produces.
- 2026-09-05 — Is a hardware isolation boundary in scope?
  docs/264-docker-sandboxes-evaluation deferred that, and its recorded trigger
  names repo-declared BuildKit builds. It stays deferred: this feature is about
  what a build can reach on the network, and buys no kernel boundary. See
  *Residual risk* in `plan.md` for what that leaves open.
