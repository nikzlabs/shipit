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
  /**
   * The pending "Saved" confirmation timer.
   *
   * Held in a ref so it can be cancelled. Left dangling, its callback runs
   * `setSaving`/`setSaved` on an unmounted component — harmless in a browser,
   * fatal in a test worker, where the timer outlives the jsdom teardown and
   * React's scheduler dereferences a `window` that no longer exists. That
   * surfaced as a red CI run whose every test had passed
   * (`ReferenceError: window is not defined`, UNHANDLED ERRORS).
   */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- cancel the confirmation timer when the tab goes away
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

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
  // Every stored key becomes a candidate custom row. Values are unknown to the
  // browser, hence blank with `existing: true`. Declared keys are filtered out
  // below at RENDER time, not here — see the note on `pinnedCustomRows`.
  const inferredCustomRows = existingKeys.map((key) => ({ key, value: "", existing: true }));
  // A stored key belongs in the custom section only while no compose service
  // declares it — and `declared` is live, so that can change under an open
  // panel in both directions (a late `secrets_status`, or the compose file
  // gaining/losing an `x-shipit-secrets` entry).
  //
  // So the declared filter is applied at RENDER time and nowhere else. State
  // (`customRows`, and the inferred list it's seeded from) always holds every
  // stored key. That's load-bearing rather than tidy: the first edit pins
  // `customRows`, and a key omitted from that pin is gone for good — if
  // `declared` later drops it, it's in neither section, so Save puts it in
  // neither `set` nor `keep` and the server DELETES the stored secret. Kept in
  // state, it just reappears.
  //
  // Only rows backed by a stored value (`existing`) are hidden. A blank row the
  // user is still filling in stays put whatever they name it.
  const pinnedCustomRows = customRows ?? inferredCustomRows;
  // Rendered position → index into `pinnedCustomRows`, so the row handlers
  // (which receive the rendered index) can write the right element back.
  const visibleCustomIdx = pinnedCustomRows
    .map((_, i) => i)
    .filter((i) => !(pinnedCustomRows[i].existing && declaredNames.has(pinnedCustomRows[i].key)));
  const customRowsToShow = visibleCustomIdx.map((i) => pinnedCustomRows[i]);

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

  // `idx` on all three row handlers is a RENDERED position, and the rendered
  // list is filtered — so each maps through `visibleCustomIdx` before touching
  // state. Indexing `pinnedCustomRows` directly would edit or remove the wrong
  // row by however many keys have moved into the declared section.

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
    // `set` = values the user typed; `keep` = existing keys to preserve as-is.
    // Anything stored but in neither list is deleted server-side.
    const set: Record<string, string> = {};
    const keep: string[] = [];

    // Declared rows (guaranteed-unique names).
    for (const d of declared) {
      // Skip platform-sourced rows — they're not user-configurable. A row a
      // plugin also claims is NOT one of them (docs/262 req 23): it needs a
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
    // Replace any in-flight confirmation so two quick saves can't race to
    // decide whether the button reads "Saving..." or "Saved".
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
