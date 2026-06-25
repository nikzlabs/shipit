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
- **Deferred (not blocked) — provider OAuth CLI credential files** under `provider-accounts/<provider>/acct_*` (the `claude` / `codex` token + config files). An earlier draft said ShipIt "can't wrap them without breaking the CLIs that read them" — that reasoning was **wrong**. ShipIt *does* materialize these files itself at orchestrator-owned seams: the provisioning copy in `session-credentials-scaffold.ts` (`copyCredentialPath` → `fs.cpSync` from the account source into the per-session dir) and the per-turn token sync in `token-sync-manager.ts` (`syncProviderAccountTokenIn` / `…Back`, an `atomicCopyFile` read-then-rename). So a **decrypt-on-inject** scheme is feasible — the credentials volume could hold ciphertext, decrypted only as it's written into the session subtree.

  The actual reason it's out of scope *for this PR*: unlike the store-backed data (which only ShipIt reads/writes), the provider CLIs read **and write** the source files directly. The OAuth refreshers (`agents/claude/oauth-refresher.ts`, `agents/codex/oauth-refresher.ts`) spawn the CLI with `HOME=<accountRoot>`, so on every token refresh the CLI overwrites the source with fresh **plaintext**, behind ShipIt's back. Encrypting these at rest therefore can't be a store-method swap — it means bracketing **both** sides of every seam that touches the source: decrypt before each CLI/copy read, re-encrypt after each CLI/refresher write, across provisioning, token sync-in/back, and both refreshers. That's a separate, provider-coupled change (tracked as follow-up); meanwhile the files already sit at mode 0600 in the credentials volume.

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

- **`SecretStore`** (per-row): encrypts each `value` on write; transparently decrypts on read. A one-shot `verifyAndMigrate()` in the constructor (a) re-encrypts any legacy plaintext rows and (b) **decrypt-validates every already-encrypted row**, so a wrong/rotated key fails at construction rather than lazily on the first session's `loadSecrets`.
- **`CredentialStore`** (whole-blob): the entire credentials JSON is encrypted as **one** AES-GCM blob on disk — so every present and future field is covered with no per-field plumbing. `load()` decrypts (and re-encrypts a legacy plaintext file once, via a *throwing* write so a failed migration surfaces instead of silently leaving plaintext on disk). Mode is held at 0600 with an explicit `chmod` after each write (the `writeFileSync` mode only applies on create, so a pre-existing looser file is repaired).

The cipher is **injected**, not self-resolved by the constructors: `new SecretStore(db)` / `new CredentialStore(dir)` with no cipher behave exactly as before (plaintext). `app-di.ts` resolves the cipher once and injects it into both stores. This keeps the change additive — every existing `new XStore(...)` test call site is untouched — and centralizes key resolution + the fail-closed boot error in one place.

## Migration / backward compatibility

Existing installs have plaintext data. Both paths are **transparent read + re-encrypt**:

- Reads detect the `shipit:enc:v1:` prefix; absent ⇒ legacy plaintext, returned as-is.
- Writes always encrypt. Plus a one-shot re-encryption on store construction (per-row for secrets, whole-file for credentials) so plaintext doesn't linger until the next user-driven write.

No data is destroyed on upgrade, and no data is wiped on a key error — a wrong/missing key (or encryption disabled while encrypted data exists) surfaces as a loud boot exception, never as an empty store or as ciphertext silently handed back as a value.

## Failure modes

| Situation | Behavior |
|---|---|
| No key configured (first boot) | Generate + persist key file (mode 0600), encryption on. |
| `SHIPIT_SECRET_KEY` malformed | Throw at boot (fail closed). |
| Key file present but wrong size / unreadable | Throw (never regenerate over it). |
| Wrong / rotated key vs existing ciphertext | GCM auth failure → throw **at construction** (both stores: `CredentialStore.load`, `SecretStore.verifyAndMigrate` decrypt-validation). **No silent wipe.** |
| Tampered ciphertext | GCM auth failure → throw. |
| Encryption disabled / key missing **while encrypted data exists** | Throw at construction in both stores — never treat ciphertext as a plaintext value (`SecretStore`) or misread an encrypted blob as corrupt JSON → reset → overwrite (`CredentialStore`, which would be a silent wipe). |
| `SHIPIT_SECRET_ENCRYPTION=off` | Cipher is `null` → plaintext. Safe only when no encrypted data exists yet; otherwise the row above throws (deliberate decrypt-export required first). |
| Legacy-plaintext re-encrypt write fails | Throw at construction (don't continue with plaintext-on-disk after the operator opted into encryption). |
| Two orchestrators race to create the key file on a fresh shared volume | Exclusive create (`wx`); the loser adopts the winner's key on EEXIST — never overwrites it (which would orphan data the winner already encrypted). |
| Test mode (`serveStatic === false`, or vitest with `NODE_ENV !== "production"`) | Plaintext by default; cipher behavior covered by dedicated unit tests, opt-in via `deps.secretCipher`. The `NODE_ENV` guard keeps a stray `VITEST` from disabling encryption in a real deployment. |

## Key files

- `src/server/orchestrator/secret-cipher.ts` — `SecretCipher` (AES-256-GCM), `resolveSecretCipher`, `parseSecretKey`, `isEncrypted`, `ENC_PREFIX`.
- `src/server/orchestrator/secret-store.ts` — optional `cipher` param; per-row encrypt/decrypt + `verifyAndMigrate()` (re-encrypt plaintext + decrypt-validate existing ciphertext + fail-closed when encryption is off over encrypted rows).
- `src/server/orchestrator/credential-store.ts` — optional `cipher` param; whole-blob encrypt/decrypt in `load()`/`save()`.
- `src/server/orchestrator/app-di.ts` — resolves the cipher once (`secretCipher` dep), injects into both stores; plaintext in test mode.
- `src/server/shipit-docs/secrets.md`, `environment.md` — self-hoster-facing env var docs.

## Tests

- `secret-cipher.test.ts` — round-trip, fresh-IV non-determinism, unicode/empty, legacy-plaintext passthrough, tamper rejection, wrong-key rejection, short-ciphertext, key-size guard; `parseSecretKey` hex/base64/malformed; `resolveSecretCipher` generate-and-persist, reuse, env-key precedence, malformed-env throw, wrong-size-file throw, kill switch.
- `credential-store.test.ts` → `encryption` describe — on-disk ciphertext, 0600 mode, legacy re-encrypt, fail-closed wrong key, fail-closed when encrypted-but-no-cipher, mode repair on a pre-existing 0644 file.
- `integration_tests/secret-store.test.ts` → `encryption` describe — on-disk ciphertext column, legacy row re-encrypt, fail-closed wrong key (at construction), fail-closed when encrypted rows exist but no cipher.

## Review hardening (Codex pass)

**Pass 1** surfaced fail-closed gaps that are now fixed: `SecretStore` only failed on a wrong key lazily (now decrypt-validates at construction); turning encryption **off** over encrypted data silently degraded (`CredentialStore` would have reset-then-overwritten the file — a wipe; `SecretStore` would have returned ciphertext as a value) — both now throw; the legacy re-encrypt write was best-effort (now throws); and `mode: 0600` didn't repair a pre-existing looser file (now `chmod`ed). The `VITEST` test gate is guarded by `NODE_ENV !== "production"` so it can't disable encryption in a real deployment.

**Pass 2** confirmed all five pass-1 fixes as correct/complete and found no blockers. One remaining race was fixed: first-boot key-file creation was TOCTOU (`existsSync` → `writeFileSync`), so two orchestrators on a fresh shared volume could generate divergent keys; now an exclusive `wx` create makes the loser adopt the winner's key on EEXIST instead of overwriting it.

Confirmed-solid across both passes: AES-256-GCM usage (random IV per record, tag enforced) and the provider-OAuth deferral reasoning.
