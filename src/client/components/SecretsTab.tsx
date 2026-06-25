import { useState, useRef } from "react";
import { Button } from "./ui/button.js";
import { DeclaredSecretRow } from "./DeclaredSecretRow.js";
import { usePreviewStore } from "../stores/preview-store.js";

/**
 * Save payload sent to `PUT /api/secrets`. Because the browser never receives
 * existing secret *values* (security: see `loadSecretNames`), it can't send a
 * full replacement map. Instead it sends `set` (keys whose value the user
 * typed) and `keep` (existing keys to preserve as-is). Any existing key in
 * neither list is deleted server-side.
 */
export interface SecretsSavePayload {
  set: Record<string, string>;
  keep: string[];
}

export interface SecretsTabProps {
  repoUrl?: string;
  onSecretsSave?: (repoUrl: string, payload: SecretsSavePayload) => void;
  /** Loads the *names* of secrets set for the repo — never their values. */
  onSecretsLoad?: (repoUrl: string) => Promise<string[]>;
}

/**
 * Settings → Secrets tab. Renders three sections:
 *
 *   1. **Declared secrets** — from `x-shipit-secrets` in the active repo's
 *      compose file (live via the `secrets_status` WS message). Shows the
 *      description, required indicator, consumer-service chips, and an
 *      `agent`/`platform` badge when applicable. Platform-sourced rows are
 *      read-only.
 *   2. **Custom secrets** — env vars the user has saved but no compose
 *      service declared. They aren't injected anywhere (declaring them is
 *      the wiring), but we keep them visible so the user can clean up
 *      stale leftovers.
 *   3. A "+ Add custom variable" affordance for ad-hoc env vars.
 *
 * The Save button writes the union of declared values + custom entries
 * back to the repo's secret store via `PUT /api/secrets`.
 */
export function SecretsTab({ repoUrl, onSecretsSave, onSecretsLoad }: SecretsTabProps) {
  // Live snapshot of declared secrets from the running compose stack.
  const declared = usePreviewStore((s) => s.secrets.declared);
  const missingByService = usePreviewStore((s) => s.secrets.missingByService);

  // Names of secrets that already have a stored value. Loaded once when the
  // tab opens. The browser NEVER receives the values themselves — set secrets
  // render as a masked "saved" placeholder, and we only send back the values
  // the user actually types (see `save`).
  const [existingKeys, setExistingKeys] = useState<string[]>([]);
  // Values the user typed this session, keyed by env var name. Empty on load;
  // a key present here (non-empty) means "overwrite with this new value".
  const [values, setValues] = useState<Record<string, string>>({});
  // Declared keys the user explicitly cleared (the declared rows have no
  // remove button — Clear marks a set value for deletion).
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  // Custom (user-added or undeclared-but-stored) entries. `existing` marks a
  // row backed by a stored value so a blank input means "keep" rather than
  // "empty". `null` until first edit, then the editable source of truth.
  const [customRows, setCustomRows] = useState<
    { key: string; value: string; existing: boolean }[] | null
  >(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);

  // Lazy-load on first render. Subsequent re-renders skip.
  if (!loadedRef.current && repoUrl && onSecretsLoad) {
    loadedRef.current = true;
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget in render
    void onSecretsLoad(repoUrl).then((keys) => {
      setExistingKeys(keys);
      setLoaded(true);
    }).catch(() => {
      setLoaded(true);
    });
  }

  const declaredNames = new Set(declared.map((d) => d.name));
  const existingSet = new Set(existingKeys);
  // Stored keys not covered by a declared row surface as editable custom rows
  // so the user can see and manage them. Values are unknown to the browser,
  // hence blank with `existing: true`.
  const inferredCustomRows = existingKeys
    .filter((k) => !declaredNames.has(k))
    .map((key) => ({ key, value: "", existing: true }));
  const customRowsToShow = customRows ?? inferredCustomRows;

  function setDeclaredValue(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    // Typing a value supersedes a prior Clear.
    setCleared((c) => {
      if (!c.has(name)) return c;
      const next = new Set(c);
      next.delete(name);
      return next;
    });
    setSaved(false);
  }

  function clearDeclaredValue(name: string) {
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== name)));
    setCleared((c) => new Set(c).add(name));
    setSaved(false);
  }

  function setCustomKey(idx: number, key: string) {
    setCustomRows((rows) => {
      const next = [...(rows ?? inferredCustomRows)];
      next[idx] = { ...next[idx], key };
      return next;
    });
    setSaved(false);
  }

  function setCustomValue(idx: number, value: string) {
    setCustomRows((rows) => {
      const next = [...(rows ?? inferredCustomRows)];
      next[idx] = { ...next[idx], value };
      return next;
    });
    setSaved(false);
  }

  function removeCustomRow(idx: number) {
    setCustomRows((rows) => (rows ?? inferredCustomRows).filter((_, i) => i !== idx));
    setSaved(false);
  }

  function addCustomRow() {
    setCustomRows((rows) => [...(rows ?? inferredCustomRows), { key: "", value: "", existing: false }]);
    setSaved(false);
  }

  function save() {
    if (!repoUrl || !onSecretsSave) return;
    setSaving(true);
    // `set` = values the user typed; `keep` = existing keys to preserve as-is.
    // Anything stored but in neither list is deleted server-side.
    const set: Record<string, string> = {};
    const keep: string[] = [];

    // Declared rows (guaranteed-unique names).
    for (const d of declared) {
      // Skip platform-sourced rows — they're not user-configurable.
      if (d.source?.startsWith("platform:")) continue;
      const typed = values[d.name];
      if (typeof typed === "string" && typed.length > 0) {
        set[d.name] = typed;
      } else if (existingSet.has(d.name) && !cleared.has(d.name)) {
        keep.push(d.name);
      }
      // else: never set, or explicitly cleared → omit → deleted.
    }

    // Custom rows (user-keyed), with empty-key guard.
    for (const row of customRowsToShow) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.value.length > 0) {
        set[k] = row.value;
      } else if (row.existing && existingSet.has(k)) {
        keep.push(k);
      }
      // else: new blank row → omit.
    }

    onSecretsSave(repoUrl, { set, keep });
    setTimeout(() => {
      setSaving(false);
      setSaved(true);
    }, 500);
  }

  if (!loaded) {
    return <p className="text-sm text-(--color-text-tertiary)">Loading...</p>;
  }

  return (
    <>
      {/* Declared secrets (from x-shipit-secrets). Hidden when the repo's
          compose file declares nothing — the tab shrinks to the custom-only
          legacy form. */}
      {declared.length > 0 && (
        <section className="space-y-2" data-testid="secrets-declared-section">
          <header className="space-y-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-(--color-text-secondary)">
              Declared by your compose file
            </h4>
            <p className="text-xs text-(--color-text-tertiary)">
              From <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code>.
              Each value is injected only into the services that listed it.
            </p>
          </header>
          <div className="space-y-3">
            {declared.map((d) => (
              <DeclaredSecretRow
                key={d.name}
                requirement={d}
                value={values[d.name] ?? ""}
                isSet={existingSet.has(d.name) && !cleared.has(d.name)}
                missing={missingByService}
                onChange={(v) => setDeclaredValue(d.name, v)}
                onClear={() => clearDeclaredValue(d.name)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Custom (undeclared) secrets — user-added values not referenced by
          any compose service. Always shown so users can clean up stale
          leftovers. */}
      <section className="space-y-2" data-testid="secrets-custom-section">
        <header className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-(--color-text-secondary)">
            Custom variables
          </h4>
          <p className="text-xs text-(--color-text-tertiary)">
            Stored for this repo but not yet referenced by any compose service.
            Add them to <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code> in your compose file to inject them.
          </p>
        </header>
        <div className="space-y-2">
          {customRowsToShow.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={row.key}
                onChange={(e) => setCustomKey(idx, e.target.value)}
                placeholder="KEY"
                className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                data-testid={`secret-key-${idx}`}
              />
              <input
                type="password"
                value={row.value}
                onChange={(e) => setCustomValue(idx, e.target.value)}
                placeholder={row.existing ? "•••••••• saved — type to replace" : "value"}
                className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                data-testid={`secret-value-${idx}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeCustomRow(idx)}
                className="text-(--color-text-tertiary) hover:text-(--color-error) shrink-0 h-7 w-7 p-0"
                aria-label="Remove secret"
                data-testid={`secret-remove-${idx}`}
              >
                &times;
              </Button>
            </div>
          ))}
        </div>
        <button
          onClick={addCustomRow}
          className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors self-start"
          data-testid="secret-add"
        >
          + Add variable
        </button>
      </section>

      <div className="flex justify-end mt-2">
        <Button
          variant="primary"
          size="md"
          disabled={saving}
          onClick={save}
          className="rounded-md"
          data-testid="secrets-save"
        >
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </Button>
      </div>
    </>
  );
}
