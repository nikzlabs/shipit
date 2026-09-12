// eslint-disable-next-line no-restricted-imports -- useEffect: clear the pending save-confirmation timer on unmount
import { useState, useRef, useEffect } from "react";
import { Button } from "./ui/button.js";
import { DeclaredSecretRow, isPlatformProvided } from "./DeclaredSecretRow.js";
import { SettingsTabPane } from "./Settings/SettingsTabPane.js";
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

export function SecretsTab({ repoUrl, onSecretsSave, onSecretsLoad }: SecretsTabProps) {

  const declared = usePreviewStore((s) => s.secrets.declared);
  const missingByService = usePreviewStore((s) => s.secrets.missingByService);

  // tab opens. The browser NEVER receives the values themselves — set secrets

  const [existingKeys, setExistingKeys] = useState<string[]>([]);

  const [values, setValues] = useState<Record<string, string>>({});

  const [cleared, setCleared] = useState<Set<string>>(new Set());

  const [customRows, setCustomRows] = useState<
    { key: string; value: string; existing: boolean }[] | null
  >(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);

  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- cancel the confirmation timer when the tab goes away
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

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

  const inferredCustomRows = existingKeys.map((key) => ({ key, value: "", existing: true }));

  // stored key. That's load-bearing rather than tidy: the first edit pins

  const pinnedCustomRows = customRows ?? inferredCustomRows;

  const visibleCustomIdx = pinnedCustomRows
    .map((_, i) => i)
    .filter((i) => !(pinnedCustomRows[i].existing && declaredNames.has(pinnedCustomRows[i].key)));
  const customRowsToShow = visibleCustomIdx.map((i) => pinnedCustomRows[i]);

  function setDeclaredValue(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));

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
    const next = [...pinnedCustomRows];
    const at = visibleCustomIdx[idx];
    next[at] = { ...next[at], key };
    setCustomRows(next);
    setSaved(false);
  }

  function setCustomValue(idx: number, value: string) {
    const next = [...pinnedCustomRows];
    const at = visibleCustomIdx[idx];
    next[at] = { ...next[at], value };
    setCustomRows(next);
    setSaved(false);
  }

  function removeCustomRow(idx: number) {
    const at = visibleCustomIdx[idx];
    setCustomRows(pinnedCustomRows.filter((_, i) => i !== at));
    setSaved(false);
  }

  function addCustomRow() {
    setCustomRows([...pinnedCustomRows, { key: "", value: "", existing: false }]);
    setSaved(false);
  }

  function save() {
    if (!repoUrl || !onSecretsSave) return;
    setSaving(true);

    const set: Record<string, string> = {};
    const keep: string[] = [];

    for (const d of declared) {

      // real value, and the row is editable, so it must save like any other.
      if (isPlatformProvided(d)) continue;
      const typed = values[d.name];
      if (typeof typed === "string" && typed.length > 0) {
        set[d.name] = typed;
      } else if (existingSet.has(d.name) && !cleared.has(d.name)) {
        keep.push(d.name);
      }
      // else: never set, or explicitly cleared → omit → deleted.
    }

    for (const row of customRowsToShow) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.value.length > 0) {
        set[k] = row.value;
      } else if (row.existing && existingSet.has(k)) {
        keep.push(k);
      }

    }

    onSecretsSave(repoUrl, { set, keep });
    // Replace any in-flight confirmation so two quick saves can't race to

    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      savedTimerRef.current = null;
      setSaving(false);
      setSaved(true);
    }, 500);
  }

  if (!loaded) {
    return <p className="text-sm text-(--color-text-tertiary)">Loading...</p>;
  }

  return (
    <SettingsTabPane
      testId="secrets-tab"
      footer={
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
      }
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Environment Variables</h3>
        <p className="text-xs text-(--color-text-secondary)">
          Secrets are injected into the services that declare them in <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code>. The agent only sees values you explicitly mark with <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">agent: true</code>.
        </p>
      </div>

      {/* Declared secrets — `x-shipit-secrets`, plus the credential names
          activated plugins declare (docs/262 req 23). Hidden when nothing
          declares anything — the tab shrinks to the custom-only legacy form. */}
      {declared.length > 0 && (
        <section className="space-y-2" data-testid="secrets-declared-section">
          <header className="space-y-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-(--color-text-secondary)">
              Declared for this project
            </h4>
            <p className="text-xs text-(--color-text-tertiary)">
              From <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code>, and
              from the plugins this project uses. Each value is injected only
              into the services that listed it; a plugin row shows which plugin
              asked for the name.
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
    </SettingsTabPane>
  );
}
