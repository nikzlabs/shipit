# Checklist

- [x] requirements.md — req 1–4 from the issue, resolved questions receipted
- [x] plan.md — Q1/Q2 verified at source, fix design, unsafe-alternative analysis
- [x] session-store: `historyBaseline` field, `setHistoryBaseline` action, clear-on-plain-array in `setMessages`, `initialResettableState`
- [x] session-data: conditional transcript install on the 304 path; seeds and all other steps unchanged
- [x] Tests: live rows kept on 304, materialize-after-clear kept green, fork-style switch installs, seeds still run on 304, reset clears the marker
- [x] `npm run typecheck` green
- [x] `npm run lint:dev` green
- [x] `npm run test:dev` green including the new tests
- [x] Runtime verification: six mid-turn 304s in a real session, zero truncations; 200s install as designed
