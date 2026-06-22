---
issue: https://linear.app/shipit-ai/issue/SHI-191
title: Secrets at-rest encryption
description: Encrypt the per-repo secrets and account-wide credentials ShipIt persists, with a zero-config default key and a fail-closed bootstrap.
---

# Secrets at-rest encryption

## Why

ShipIt persists two buckets of sensitive data **in plaintext** on disk:

1. **Per-repo secrets** — `secret-store.ts`, the SQLite `secrets (repo_url, key, value)` table. `value` is plaintext.
2. **Account-wide credentials** — `credential-store.ts`, the single `shipit-credentials.json` (mode 0600) in the credentials volume. Holds `githubToken`, `linear.token`, `voiceProviderKeys`, `voiceWebhook.token`, `agentEnv` (including `mcp__*` secret values), and `mcpOAuth` tokens — all plaintext.

PR #1567 closed the **transport** leak (`GET /api/secrets` no longer returns plaintext values to the browser). This feature closes the **at-rest** leak: the realistic threat now is the persisted bytes being copied *without* the running system — a leaked SQLite dump, a backup of `shipit-credentials.json`, a value pasted into a bug report or log. Encryption-at-rest makes those bytes useless without the key.

## Threat model (what this does and does not protect)

- **Protects:** persisted bytes copied **without the key**. A dumped DB / credentials file / pasted value is ciphertext.
- **Does NOT protect:** an attacker who can read the **entire credentials volume**. With the zero-config default the key file lives on that same volume, so a full-volume compromise yields both key and data. Operators who need to defend against that keep the key **off** the volume via `SHIPIT_SECRET_KEY` (Docker secret / KMS-injected). This is an honest, documented limit — any volume-local key scheme has it.
- **Out of scope:** provider OAuth CLI credential files under `provider-accounts/<provider>/acct_*`. ShipIt doesn't own their format (the provider CLIs — `claude`, `codex` — write them), so app-level encryption can't wrap them without breaking the CLIs that read them. They already sit at mode 0600 in the credentials volume. Encrypting them is a separate, provider-coupled effort.

## Key management (the crux)

**Decision: auto-generated key file on the credentials volume is the default; `SHIPIT_SECRET_KEY` env overrides it.**

`resolveSecretCipher({ credentialsDir })` (in `secret-cipher.ts`) resolves the 32-byte key with this precedence:

1. **`SHIPIT_SECRET_KEY`** (env) — an externally-managed key (64 hex chars, or base64, optionally `hex:` / `base64:` prefixed). For operators who want the key outside the volume. **Malformed ⇒ throw at boot** (fail closed — never fall back to plaintext).
2. **Key file** at `SHIPIT_SECRET_KEY_FILE` (default `<credentialsDir>/secret-key`, mode 0600). Present-but-unreadable / wrong-size ⇒ **throw** — we never regenerate over an existing key, which would orphan every record encrypted under it.
3. **Neither present ⇒ generate** a fresh 32-byte key, persist it to the key file (mode 0600), use it. This is the **zero-config self-hoster default**.

A kill switch `SHIPIT_SECRET_ENCRYPTION=0|false|off` returns `null` (plaintext) for operators who explicitly opt out.

**Why auto-generated-file as the default rather than a required env key:** ShipIt always runs in Docker with a persistent credentials volume. Requiring `SHIPIT_SECRET_KEY` would make every self-hoster do key bootstrap before the app boots — high friction, and a missing key would have to either hard-fail (bad first-run UX) or silently store plaintext (defeats the feature). The auto-generated file gives real protection against the realistic threat (bytes copied without the volume) with **zero** configuration, while the env override is there for operators who want stronger separation. The cost — key-on-same-volume — is stated plainly above.

## Cipher & record format

- **AES-256-GCM**, `node:crypto` only (no new dependency). Per-record random **12-byte IV** + **16-byte auth tag**.
- Each encrypted value is a self-describing string:

  ```
  shipit:enc:v1:<base64( iv[12] || tag[16] || ciphertext )>
  ```

- The `shipit:enc:v1:` prefix is **both** the version marker **and** the migration discriminator. `SecretCipher.decrypt()` returns any value *without* the prefix verbatim — so legacy plaintext reads transparently.
- A wrong/rotated key or a tampered value fails the GCM auth-tag check and **throws**. Callers must let it propagate — never swallow to an empty value (that would let the next write overwrite real data: a silent wipe).

## Where encryption lives (boundary inside the stores)

The encrypt/decrypt boundary is entirely inside the two store classes, so every caller (`loadSecrets`, `getGithubToken`, env resolution in `service-manager-setup.ts`, `getAllAgentEnv` → `process.env` at boot, …) is **unchanged**.

- **`SecretStore`** (per-row): encrypts each `value` on write; transparently decrypts on read. A one-shot `migrateToEncrypted()` in the constructor re-encrypts any plaintext rows (idempotent, single transaction, no-op after first boot).
- **`CredentialStore`** (whole-blob): the entire credentials JSON is encrypted as **one** AES-GCM blob on disk — so every present and future field is covered with no per-field plumbing. `load()` decrypts; a legacy plaintext file is re-encrypted once on construction. Mode stays 0600.

The cipher is **injected**, not self-resolved by the constructors: `new SecretStore(db)` / `new CredentialStore(dir)` with no cipher behave exactly as before (plaintext). `app-di.ts` resolves the cipher once and injects it into both stores. This keeps the change additive — every existing `new XStore(...)` test call site is untouched — and centralizes key resolution + the fail-closed boot error in one place.

## Migration / backward compatibility

Existing installs have plaintext data. Both paths are **transparent read + re-encrypt**:

- Reads detect the `shipit:enc:v1:` prefix; absent ⇒ legacy plaintext, returned as-is.
- Writes always encrypt. Plus a one-shot re-encryption on store construction (per-row for secrets, whole-file for credentials) so plaintext doesn't linger until the next user-driven write.

No data is destroyed on upgrade, and no data is wiped on a key error — a wrong/missing key surfaces as a loud boot/read exception, never as an empty store.

## Failure modes

| Situation | Behavior |
|---|---|
| No key configured (first boot) | Generate + persist key file (mode 0600), encryption on. |
| `SHIPIT_SECRET_KEY` malformed | Throw at boot (fail closed). |
| Key file present but wrong size / unreadable | Throw (never regenerate over it). |
| Wrong / rotated key vs existing ciphertext | GCM auth failure → throw on read/construction. **No silent wipe.** |
| Tampered ciphertext | GCM auth failure → throw. |
| `SHIPIT_SECRET_ENCRYPTION=off` | Cipher is `null` → plaintext (explicit opt-out). |
| Test mode (`serveStatic === false`) | Plaintext by default; cipher behavior covered by dedicated unit tests, opt-in via `deps.secretCipher`. |

## Key files

- `src/server/orchestrator/secret-cipher.ts` — `SecretCipher` (AES-256-GCM), `resolveSecretCipher`, `parseSecretKey`, `isEncrypted`, `ENC_PREFIX`.
- `src/server/orchestrator/secret-store.ts` — optional `cipher` param; per-row encrypt/decrypt + `migrateToEncrypted()`.
- `src/server/orchestrator/credential-store.ts` — optional `cipher` param; whole-blob encrypt/decrypt in `load()`/`save()`.
- `src/server/orchestrator/app-di.ts` — resolves the cipher once (`secretCipher` dep), injects into both stores; plaintext in test mode.
- `src/server/shipit-docs/secrets.md`, `environment.md` — self-hoster-facing env var docs.

## Tests

- `secret-cipher.test.ts` — round-trip, fresh-IV non-determinism, unicode/empty, legacy-plaintext passthrough, tamper rejection, wrong-key rejection, short-ciphertext, key-size guard; `parseSecretKey` hex/base64/malformed; `resolveSecretCipher` generate-and-persist, reuse, env-key precedence, malformed-env throw, wrong-size-file throw, kill switch.
- `credential-store.test.ts` → `encryption` describe — on-disk ciphertext, 0600 mode, legacy re-encrypt, fail-closed wrong key.
- `integration_tests/secret-store.test.ts` → `encryption` describe — on-disk ciphertext column, legacy row re-encrypt, fail-closed wrong key.
