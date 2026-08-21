# Preview viewport modes — Checklist

## Audit

- [x] Map every numbered requirement to existing code and tests (docs/066 implementation)
- [x] Confirm per-session snapshot round-trips viewport state (preview-store.test.ts)

## Fixes found by the audit

- [x] Sync DeviceSelector custom-size inputs when `customSize` changes externally (session switch)
- [ ] Test: inputs reflect another session's restored custom size while mounted
- [x] Show the scale percentage only when it is below 100 after rounding
- [ ] Test: no "(100%)" artifact when scale rounds up to 100

## Verification

- [ ] typecheck passes
- [ ] lint:dev passes
- [ ] test:dev passes, plus DeviceSelector / PreviewFrame / preview-store suites
- [ ] Live browser check: fill → preset → rotate → freeform → fill, scaled-down case visually confirmed
