import { useState, useRef } from "react";
import { Button } from "./ui/button.js";
import { DeclaredSecretRow } from "./DeclaredSecretRow.js";
import { usePreviewStore } from "../stores/preview-store.js";

export interface SecretsTabProps {
  repoUrl?: string;
  onSecretsSave?: (repoUrl: string, secrets: Record<string, string>) => void;
  onSecretsLoad?: (repoUrl: string) => Promise<Record<string, string>>;
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

  // User-saved values. Keyed by env var name. Loaded once when the tab opens.
  const [values, setValues] = useState<Record<string, string>>({});
  // Custom (user-added) entries that aren't in `declared`. Stored as an
  // ordered list so adding a new row keeps it in place; merged with `values`
  // on save.
  const [customRows, setCustomRows] = useState<{ key: string; value: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);

  // Lazy-load on first render. Subsequent re-renders skip.
  if (!loadedRef.current && repoUrl && onSecretsLoad) {
    loadedRef.current = true;
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget in render
    void onSecretsLoad(repoUrl).then((secrets) => {
      setValues(secrets);
      setLoaded(true);
    }).catch(() => {
      setLoaded(true);
    });
  }

  // Once the declared list loads, pull anything not declared into the custom
  // rows so the user can see and edit existing-but-undeclared values.
  // Re-runs whenever `declared` or `values` shape changes.
  const declaredNames = new Set(declared.map((d) => d.name));
  const inferredCustomRows = Object.entries(values)
    .filter(([k]) => !declaredNames.has(k))
    .map(([key, value]) => ({ key, value }));
  // Use the inferred rows as the source of truth on first render, then let
  // the user mutate via setCustomRows. We compare lengths as a cheap
  // freshness check — declared changes can demote rows from declared to
  // custom.
  const customRowsToShow = customRows.length > 0 ? customRows : inferredCustomRows;

  function setDeclaredValue(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    setSaved(false);
  }

  function setCustomKey(idx: number, key: string) {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      const next = [...base];
      next[idx] = { ...next[idx], key };
      return next;
    });
    setSaved(false);
  }

  function setCustomValue(idx: number, value: string) {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      const next = [...base];
      next[idx] = { ...next[idx], value };
      return next;
    });
    setSaved(false);
  }

  function removeCustomRow(idx: number) {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      return base.filter((_, i) => i !== idx);
    });
    setSaved(false);
  }

  function addCustomRow() {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      return [...base, { key: "", value: "" }];
    });
    setSaved(false);
  }

  function save() {
    if (!repoUrl || !onSecretsSave) return;
    setSaving(true);
    const out: Record<string, string> = {};
    // Declared values first (those are guaranteed-unique names).
    for (const d of declared) {
      // Skip platform-sourced rows — they're not user-configurable.
      if (d.source?.startsWith("platform:")) continue;
      const v = values[d.name];
      if (typeof v === "string") out[d.name] = v;
    }
    // Custom rows (user-keyed), with empty-key / duplicate-key guards.
    for (const row of customRowsToShow) {
      const k = row.key.trim();
      if (!k) continue;
      out[k] = row.value;
    }
    onSecretsSave(repoUrl, out);
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
                missing={missingByService}
                onChange={(v) => setDeclaredValue(d.name, v)}
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
                placeholder="value"
                className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                data-testid={`secret-value-${idx}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeCustomRow(idx)}
                className="text-(--color-text-tertiary) hover:text-(--color-error) shrink-0"
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
