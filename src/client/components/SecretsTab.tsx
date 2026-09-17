/**
 * The repository's secrets, as the panel `project.secrets` names
 * (docs/308-data-driven-settings slice 7).
 *
 * A collection with operations of its own — add, remove, clear, save several at
 * once — so it keeps its own reader and writer, as every registered panel does
 * (inventory.md P11). Both are its own rather than the dialog's since this
 * slice: a component takes the setting's key and nothing else, so the repository
 * is a read and the two requests live here.
 */

import { useRef, useState } from "react";
import { Button } from "./ui/button.js";
import { DeclaredSecretRow, isPlatformProvided } from "./DeclaredSecretRow.js";
import { SettingCopy } from "./Settings/declared.js";
import { useProjectRepoUrl } from "./Settings/components/project-repo.js";
import { usePreviewStore, type DeclaredSecretState } from "../stores/preview-store.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useApi } from "../hooks/useApi.js";
import { parseRepoLabel } from "../utils/repo-label.js";

/**
 * Save payload sent to `PUT /api/secrets`. Because the browser never receives
 * existing secret *values* (security: see `loadSecretNames`), it can't send a
 * full replacement map. Instead it sends `set` (keys whose value the user
 * typed) and `keep` (existing keys to preserve as-is). Any existing key in
 * neither list is deleted server-side.
 */
interface SecretsSavePayload {
  set: Record<string, string>;
  keep: string[];
}

/** Stable empties, so a panel the snapshot does not describe re-renders no more. */
const NO_DECLARATIONS: DeclaredSecretState[] = [];
const NO_MISSING: Record<string, string[]> = {};

/**
 * The newest save per repository, module-level so it outlives the panel.
 *
 * Switching tabs unmounts this panel, so a second save can start while the
 * first is still out — and the older answer must not report on a state nobody
 * is in any more. It is `saveSetting`'s per-setting sequence, at the one
 * destination this panel writes.
 */
const SAVES = new Map<string, number>();

export function SecretsTab() {
  const repoUrl = useProjectRepoUrl();
  // Every piece of state below is one repository's — names loaded, values
  // typed, rows added — so the panel is remounted rather than reset when the
  // dialog is re-pointed at another.
  return <SecretsPanel key={repoUrl ?? ""} repoUrl={repoUrl} />;
}

function SecretsPanel({ repoUrl }: { repoUrl: string | null }) {
  const { get, put } = useApi();

  /*
    The declared names describe the ACTIVE SESSION's compose file, not this
    dialog's repository, so they apply only where the two agree (found in
    review). Reading them regardless was a way to LOSE a secret: another
    repository's declaration hides a stored key from the custom rows, and a
    hidden key is in neither `set` nor `keep`, so saving deletes it.
  */
  const sessionRepoUrl = useSessionStore(
    (s) => s.sessions.find((session) => session.id === s.sessionId)?.remoteUrl,
  );
  const describesThisRepo = repoUrl !== null && sessionRepoUrl === repoUrl;
  const snapshotDeclared = usePreviewStore((s) => s.secrets.declared);
  const snapshotMissing = usePreviewStore((s) => s.secrets.missingByService);
  const declared = describesThisRepo ? snapshotDeclared : NO_DECLARATIONS;
  const missingByService = describesThisRepo ? snapshotMissing : NO_MISSING;

  // Names only: the browser never receives a stored value (`loadSecretNames`).
  const [existingKeys, setExistingKeys] = useState<string[]>([]);

  const [values, setValues] = useState<Record<string, string>>({});

  const [cleared, setCleared] = useState<Set<string>>(new Set());

  const [customRows, setCustomRows] = useState<
    { key: string; value: string; existing: boolean }[] | null
  >(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);
  /** Typed since the save in flight was sent, so its "Saved" is not this state's. */
  const editedSinceSendRef = useRef(false);

  function load(): void {
    if (!repoUrl) return;
    loadedRef.current = true;
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget in render
    void get<{ keys: string[] }>(`/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`)
      .then(({ keys }) => {
        setExistingKeys(keys);
        setLoaded(true);
      }).catch((err: unknown) => {
        console.error("[secrets] reading the stored names failed:", err);
        setLoadFailed(true);
      });
  }

  if (!loadedRef.current) load();

  /** Anything the user changed, which a save in flight no longer speaks for. */
  function touched(): void {
    editedSinceSendRef.current = true;
    setSaved(false);
  }

  const declaredNames = new Set(declared.map((d) => d.name));
  const existingSet = new Set(existingKeys);

  // Until the first edit the custom rows are inferred from the stored names;
  // from then on the user's own list is what renders, so a later snapshot can
  // neither reorder it nor bring back a row they removed.
  const inferredCustomRows = existingKeys.map((key) => ({ key, value: "", existing: true }));
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
    touched();
  }

  function clearDeclaredValue(name: string) {
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== name)));
    setCleared((c) => new Set(c).add(name));
    touched();
  }

  function setCustomKey(idx: number, key: string) {
    const next = [...pinnedCustomRows];
    const at = visibleCustomIdx[idx];
    next[at] = { ...next[at], key };
    setCustomRows(next);
    touched();
  }

  function setCustomValue(idx: number, value: string) {
    const next = [...pinnedCustomRows];
    const at = visibleCustomIdx[idx];
    next[at] = { ...next[at], value };
    setCustomRows(next);
    touched();
  }

  function removeCustomRow(idx: number) {
    const at = visibleCustomIdx[idx];
    setCustomRows(pinnedCustomRows.filter((_, i) => i !== at));
    touched();
  }

  function addCustomRow() {
    setCustomRows([...pinnedCustomRows, { key: "", value: "", existing: false }]);
    touched();
  }

  async function save() {
    if (!repoUrl || saving) return;
    setSaving(true);

    const set: Record<string, string> = {};
    const keep: string[] = [];

    for (const d of declared) {
      // Platform-sourced rows are not user-configurable. A row a plugin also
      // claims is NOT one of them (docs/262 req 23): it needs a real value, and
      // the row is editable, so it saves like any other.
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

    /*
      "Saved" is the server's answer rather than a timer's: the panel owns the
      write since slice 7, so it knows whether the write landed and says so —
      and a refused one now reaches the user instead of being swallowed.

      Two things it must not claim, both found in review. An answer that is not
      the NEWEST save's describes a state nobody is in any more, so it reports
      nothing. And "Saved" is about the values that were SENT: typing during the
      write leaves the box holding something the server does not have.
    */
    const payload: SecretsSavePayload = { set, keep };
    const mine = (SAVES.get(repoUrl) ?? 0) + 1;
    SAVES.set(repoUrl, mine);
    editedSinceSendRef.current = false;
    try {
      await put("/api/secrets", { repoUrl, ...payload });
      if (SAVES.get(repoUrl) !== mine) return;
      if (!editedSinceSendRef.current) setSaved(true);
      // Repos without Compose emit no secrets_status event to trigger this
      // refresh. It is not part of the save: awaiting it left Save disabled as
      // "Saving..." for as long as the snapshot took (found in review).
      const id = useSessionStore.getState().sessionId;
      if (id) void usePluginReposStore.getState().fetchSnapshot(id);
    } catch (err) {
      console.error("[secrets] save failed:", err);
      if (SAVES.get(repoUrl) !== mine) return;
      // Named, because the panel it failed for may be gone by now: the dialog
      // can have been closed, or opened for another repository.
      useUiStore.getState().setToast({
        message: `Failed to save secrets for ${parseRepoLabel(repoUrl)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  /*
    A read that failed is not a repository with no secrets. Save replaces the
    stored set with what is on screen, so an empty panel offered after a failed
    read is a delete-everything button (found in review).
  */
  if (loadFailed) {
    return (
      <div className="space-y-2" data-testid="secrets-load-failed" role="alert">
        <p className="text-sm text-(--color-text-primary)">
          Could not read this repository&rsquo;s secrets, so they cannot be edited safely.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-md"
          data-testid="secrets-retry"
          onClick={() => { setLoadFailed(false); load(); }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (!loaded) {
    return <p className="text-sm text-(--color-text-tertiary)">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="secrets-tab">
      <SettingCopy settingKey="project.secrets" heading />

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
                aria-label={`Custom secret name ${idx + 1}`}
                className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                data-testid={`secret-key-${idx}`}
              />
              <input
                type="password"
                value={row.value}
                onChange={(e) => setCustomValue(idx, e.target.value)}
                placeholder={row.existing ? "•••••••• saved — type to replace" : "value"}
                aria-label={`Custom secret value ${idx + 1}`}
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

      {/*
        Save stays in sight however long the list grows, which is what the tab's
        pinned footer did before the panel moved inside the generated block. It
        sticks to the bottom of the tab's scroll area and bleeds through its
        padding, so it reads as the same bar.
      */}
      <div className="sticky bottom-0 -mx-5 -mb-4 flex items-center justify-end border-t border-(--color-border-secondary) bg-(--color-bg-elevated) px-5 py-3">
        <Button
          variant="primary"
          size="md"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md"
          data-testid="secrets-save"
          aria-label={saving ? "Saving secrets" : saved ? "Secrets saved" : "Save secrets"}
        >
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}
