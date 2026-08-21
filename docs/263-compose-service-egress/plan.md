---
issue: planning#360
title: Compose service egress containment
description: Internal-network bootstrap and per-service namespace enforcement for Compose runtime containers.
---

# Compose service egress containment

Contained Compose runtime services use a dedicated, trusted network-namespace
holder for each service. ShipIt starts the holder on the internal session
network, attaches its private egress bridge, installs the existing Tier A/B/C
controls, opens only the session subnet, and verifies the policy before it
starts repository code. The Compose service then starts with
`network_mode: container:<holder>`, so its original image entrypoint and command
have allowlisted access from their first instruction. Open sessions keep the old
networking behavior.

Repository-defined networks are replaced with Compose's `!override` tag. This
requires Docker Compose 2.24.4 or newer. Capability additions are rejected, and
contained services receive `no-new-privileges`, because either escape would let
service code alter or bypass the namespace firewall.
Repository-defined DNS is replaced while containment is active. Services must
declare a numeric, non-root, non-reserved runtime UID and lose `SETUID` and
`SETGID`. Thus repository images cannot assume resolver or proxy UIDs that the
namespace firewall trusts. Root-init images require an Open session. A holder
outlives service-process restarts, so a restarted service re-enters the same
already-contained namespace instead of creating an unprotected namespace.

## Startup ordering

The holder is trusted ShipIt code and contains no repository entrypoint or
command. `prepareComposeServiceStart` creates one holder per service, connects
it to the internal session network with the service DNS aliases, attaches the
egress bridge, and installs containment. If any step fails, Compose startup is
not invoked. Only after every required holder is ready does ShipIt run Compose.

The service override uses the holder's network namespace. ShipIt does not
replace or reconstruct the image entrypoint, command, or health check. This
preserves startup behavior for package installation, database initialization,
and similar tasks that need allowlisted internet access.

Fields incompatible with container network mode are rejected or reset while
containment is active. Preview address resolution and service-origin lookup use
the holder's session-network address when the workload container has no address
of its own.

## Scope boundary

This feature contains Compose **runtime service containers**. Docker BuildKit
build steps run in daemon-managed build containers before a Compose service
exists, so they are outside this service-network policy. Repository trust gates
whether ShipIt runs repo-declared builds. Build-network containment needs a
separate daemon/BuildKit design and is not presented as protection supplied by
this feature.

## Key files

- `src/server/orchestrator/compose-service-egress.ts` — serialized, fail-closed service namespace setup.
- `src/server/orchestrator/compose-netns-holder.ts` — per-service trusted namespace lifecycle and policy preparation.
- `src/server/orchestrator/compose-generator.ts` — internal bootstrap network and service hardening.
- `src/server/orchestrator/session-container.ts` — policy resolution, serialization, and allowlist refresh.
- `src/server/orchestrator/egress-reload.ts` — parent-scoped agent sidecar reload.
