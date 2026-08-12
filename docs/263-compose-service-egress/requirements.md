---
issue: planning#360
title: Compose service egress containment
description: Apply each session's network egress policy to its Compose-managed services.
---

# Requirements

1. A Compose runtime service in a contained session must not get unrestricted internet access before, during, or after its runtime-container startup. Dockerfile/BuildKit build steps are outside this runtime-service policy and remain gated by repository trust.
2. Compose services must use the same effective host allowlist and Contained/Open policy as their owning agent container.
3. Containment must continue to permit traffic between the agent, the orchestrator preview proxy, and services in the same session.
4. A failure to apply containment to a Compose service must fail closed and must not leave that service running with unrestricted egress.
5. Open sessions and deployments that explicitly disable egress enforcement must keep their current Compose networking behavior.

## Open questions

None.
