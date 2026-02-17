# Preview System — Remaining Work

- Port scanner: add `isScanning` guard in `runPortScan()` to prevent overlapping scans if `DEFAULT_SCAN_PORTS` grows or network latency increases
- Preview status: add debounce (~500ms) to `broadcastPreviewStatus()` to prevent burst of status messages from rapidly appearing/disappearing ports
