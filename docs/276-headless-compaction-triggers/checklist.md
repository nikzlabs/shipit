# 276 — checklist

- [x] Probe OpenCode 1.18.18 for a headless on-demand compaction trigger
- [x] Probe Grok Build 1.0.1 for a headless on-demand compaction trigger
- [x] Prove the outcome (context actually compacted), not just exit status
- [x] Check upstream docs for both CLIs
- [x] Flip both `supportsCompaction` rows, replacing the overstated comments
- [x] Grok: map `compact_boundary`, correlate the manual trigger, add `compact()`
- [x] OpenCode: transient-server compaction module + `runCompaction` + `compact()`
- [x] Tests: grok adapter (real captured fixture), opencode compaction module, opencode adapter
- [x] Verify both adapters end to end against the real CLIs
- [x] Independent review
