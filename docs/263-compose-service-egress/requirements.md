---
issue: planning#360
title: Compose service egress containment
description: Apply each session's network egress policy to its Compose-managed services.
---

# Requirements

1. A Compose runtime service in a contained session must not get unrestricted internet access before, during, or after its runtime-container startup. Dockerfile/BuildKit build steps are outside this runtime-service policy and remain gated by repository trust.
2. When a Compose service's entrypoint or command starts executing, its effective network policy must already be active. In a contained session, the service must be able to reach hosts allowed by the session allowlist from its first instruction, including during startup tasks such as package installation. It must never start in a temporary no-internet state while waiting for containment to be installed.
3. Compose services must use the same effective host allowlist and Contained/Open policy as their owning agent container.
4. Containment must continue to permit traffic between the agent, the orchestrator preview proxy, and services in the same session.
5. A failure to apply containment to a Compose service must fail closed and must not leave that service running with unrestricted egress.
6. Open sessions and deployments that explicitly disable egress enforcement must keep their current Compose networking behavior.

## Open questions

None.

## Resolved questions

- 2026-08-13: The user confirmed that allowlisted internet access must be ready before any Compose service entrypoint or command runs. Startup work such as `npm install` must not fail because ShipIt has not installed containment yet.
