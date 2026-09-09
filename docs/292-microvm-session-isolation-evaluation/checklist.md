# Per-session microVM isolation evaluation checklist

- [x] Re-check docs/264's recorded facts (Docker Sandboxes API, port model, Desktop requirement, nested-virtualization availability) against current sources and say which objections survive a direct VMM design.
- [x] Record what Firecracker, Cloud Hypervisor, Kata Containers and gVisor provide today (versions, host requirements, shared filesystem, Docker-inside, fixed overhead, boot definitions) from upstream sources.
- [x] Verify at the source every ShipIt mechanism a per-session VM would touch: preview routing, worker transport, identity by network position, Compose service addressing, egress tiers, warm pool / idle reclaim / memory sizing, mounts and overlay store, orchestrator privileges, existing hardening.
- [x] State plainly which measurement could not be made in this environment and the numbers to confirm on a live host.
- [x] Evaluate the middle option (a VM runtime for the untrusted tier only) as a first-class option, including what it breaks (netns-join egress).
- [x] Say concretely what a microVM buys over gVisor and for which threat.
- [x] Assess what a self-run VM tier could share with a remote-provider backend, keeping provider-specific detail on that tracker issue.
- [x] Restate the conditions that would change the recommendation in checkable terms.
