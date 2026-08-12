---
title: Compose service egress containment
description: Internal-network bootstrap and per-service namespace enforcement for Compose runtime containers.
---

# Compose service egress containment

Contained Compose runtime services start on the internal session network with
controlled bootstrap DNS. ShipIt then pauses each service, attaches a private
egress bridge, installs the existing Tier A/B/C controls in that namespace,
opens only the session subnet, and resumes the service. Open sessions keep the
old networking behavior.

Repository-defined networks are replaced with Compose's `!override` tag. This
requires Docker Compose 2.24.4 or newer. Capability additions are rejected, and
contained services receive `no-new-privileges`, because either escape would let
service code alter or bypass the namespace firewall.

## Scope boundary

This feature contains Compose **runtime service containers**. Docker BuildKit
build steps run in daemon-managed build containers before a Compose service
exists, so they are outside this service-network policy. Repository trust gates
whether ShipIt runs repo-declared builds. Build-network containment needs a
separate daemon/BuildKit design and is not presented as protection supplied by
this feature.

## Key files

- `src/server/orchestrator/compose-service-egress.ts` — serialized, fail-closed service namespace setup.
- `src/server/orchestrator/compose-generator.ts` — internal bootstrap network and service hardening.
- `src/server/orchestrator/session-container.ts` — policy resolution, serialization, and allowlist refresh.
- `src/server/orchestrator/egress-reload.ts` — parent-scoped agent sidecar reload.

