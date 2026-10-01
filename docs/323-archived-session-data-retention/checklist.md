# 323 — Retention period for archived session data: checklist

- [x] Migration: `archived_at`, `retention_floor_at`, `retained_data_bytes`, `retained_data_measured_at`
- [x] `SessionManager.archive` sets the archive time, `unarchive` clears it
- [x] The rule in `session-retention.ts`, with tests
- [x] The three environment variables, passed through in the VPS compose file
- [x] The sweep: measure, delete, notice, agent notice, with tests
- [x] The sweep runs in the disk escalation pass, and archive starts a pass
- [x] `dataDeletesAt` on the session lists
- [x] The date on the session row
- [x] `unarchiveSession` re-creates a sandbox workspace that is gone
- [x] Agent-facing docs and the wiki
- [ ] Independent review against the requirements
