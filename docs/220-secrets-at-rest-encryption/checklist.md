# Checklist — Secrets at-rest encryption

- [x] `SecretCipher` helper (AES-256-GCM, per-record IV + tag, versioned `shipit:enc:v1:` envelope)
- [x] `resolveSecretCipher` key management (env key → key file → auto-generate; kill switch; fail-closed)
- [x] `parseSecretKey` (hex / base64, 32-byte guard)
- [x] Wire cipher into `SecretStore` (per-row encrypt/decrypt + one-shot `migrateToEncrypted`)
- [x] Wire cipher into `CredentialStore` (whole-blob encrypt/decrypt + legacy re-encrypt on load)
- [x] Inject cipher in `app-di.ts`; plaintext default in test mode; fail-closed boot error
- [x] Unit tests: cipher round-trip, tamper, wrong-key, migration, key resolution
- [x] Store tests: on-disk ciphertext, 0600 mode, legacy migration, fail-closed
- [x] Update `shipit-docs` (env vars: `SHIPIT_SECRET_KEY`, `SHIPIT_SECRET_KEY_FILE`, `SHIPIT_SECRET_ENCRYPTION`)
- [x] `npm run typecheck` + `npm run lint:dev` clean
- [ ] Heavy suites (full `npm test`, integration) — left to CI (OOM in session container)
