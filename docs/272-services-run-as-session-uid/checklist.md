# Checklist

- [x] Confirm the deployed orchestrator accepts a contained service with no
      `user:` before removing any declaration.
- [x] Drop `user: "1000:1000"` from `dev`, `onboarding`, `sdk-test`, `android`.
      Keep `emulator`'s `1300:1301` — baked-in account, writes no workspace.
- [x] Group-write the dep dir root and any leaked cache tree in
      `reconcileDepDirCacheOwnership`, without touching the shared
      `chownRecursive` that credentials go through.
- [x] `shipit-docs/compose.md`: delete a `user:` kept for the old rule, and why —
      git ownership and dependency caches.
- [x] Verify live: dogfood `dev` runs as the session uid and logs no dubious
      ownership across restarts.
- [ ] Independent review.
