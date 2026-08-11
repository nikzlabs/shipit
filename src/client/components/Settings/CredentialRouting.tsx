/**
 * docs/252 — how ShipIt picks between the credentials of one `(service,
 * billing mode)`.
 *
 * These two controls used to exist twice over. `ProviderAccountsCard` carried a
 * `SelectionModeControl` keyed by `credentialModeKey(nativeService(provider),
 * "sub")`, and `ServicesPanel` carried a `CredentialSelectionModeControl` keyed
 * by `credentialModeKey(service.id, billingMode)` — which, for Anthropic's
 * subscription, is **the same key**. Two components, two sets of copy, one
 * stored setting. Only one of them could ever be on screen at a time, so the
 * duplication was invisible until the two cards became one.
 *
 * So both are keyed by `(service, billing mode)` here and nowhere else. That is
 * also the key the server writes (`routingSettingsKeyFor`), so nothing about
 * the stored shape changes — this is the same setting, addressed once.
 *
 * **The cutoffs stay account-backed-only, and that is not an oversight.** A
 * cutoff is a percentage of a *reported* quota, and nothing reports one for a
 * string-delivered subscription until its quota reader lands (planning#339), so
 * the control would set a number that can never fire.
 */

// useEffect is used solely for its cleanup: a pending cutoff edit must be
// persisted when the control unmounts (closing Settings), which no event
// handler can observe.
// eslint-disable-next-line no-restricted-imports -- unmount flush, see above
import { useEffect, useRef, useState } from "react";
import type { AgentId } from "../../../server/shared/types.js";
import { credentialModeKey } from "../../../server/shared/types/domain-types/credential-route.js";
import type { BillingMode } from "../../../server/shared/catalogue/index.js";
import { useSettingsStore } from "../../stores/settings-store.js";

/**
 * docs/150 req 21 — how these credentials relate to each other.
 *
 * Worded around the credentials, not the algorithm: the real question a user
 * can answer is "are these two the same kind of thing or not?", and the
 * ordering behavior follows from that. Naming the mechanism instead ("least
 * recently used") would ask them to reason about scheduling to pick correctly.
 *
 * Rendered above the cutoffs because it changes what the cutoffs *mean*: under
 * balancing, work moves between credentials continuously and a cutoff is the
 * point one drops out of the rotation, rather than the point work leaves it.
 */
export function CredentialSelectionModeControl({
  serviceId,
  billingMode,
  serviceName,
  noun,
}: {
  serviceId: string;
  billingMode: BillingMode;
  serviceName: string;
  /** "account" for a login-backed mode, "credential" for a supplied secret. */
  noun: string;
}) {
  const key = credentialModeKey(serviceId, billingMode);
  const stored = useSettingsStore((s) => s.accountSelectionMode[key]);
  const mode = stored ?? "strict";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (next: "strict" | "balanced"): Promise<void> => {
    if (next === mode) return;
    const previous = mode;
    useSettingsStore.getState().setAccountSelectionMode(key, next);
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountSelectionMode: { [key]: next } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setAccountSelectionMode(key, previous);
      setError(`Failed to update the ${serviceName} order`);
      console.error("[services] credential selection mode save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const option = (value: "strict" | "balanced", label: string, hint: string) => (
    <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs hover:bg-(--color-bg-hover)">
      <input
        type="radio"
        name={`credential-selection-mode-${key}`}
        checked={mode === value}
        disabled={saving}
        onChange={() => void save(value)}
        aria-label={`${serviceName} credential selection: ${label}`}
        className="mt-0.5 accent-(--color-accent)"
        data-testid={`credential-selection-mode-${key}-${value}`}
      />
      <span>
        <span className="text-(--color-text-secondary)">{label}</span>
        <span className="block text-(--color-text-tertiary)">{hint}</span>
      </span>
    </label>
  );

  return (
    <div data-testid={`credential-selection-mode-${key}`}>
      {option(
        "strict",
        "Use in order",
        `New sessions start on the first ${noun} with quota left. Best when they differ — a bigger plan first, a smaller one as backup.`,
      )}
      {option(
        "balanced",
        `Spread across ${noun}s`,
        `New sessions go to whichever ${noun} has been used least, so quota drains evenly. Best when they are equivalent.`,
      )}
      {error && (
        <p className="mt-1 text-xs text-(--color-text-error)" role="alert">{error}</p>
      )}
    </div>
  );
}

const CUTOFF_KEYS = ["session", "weekly"] as const;
type CutoffKey = (typeof CUTOFF_KEYS)[number];

/** What a `(service, mode)` with no stored cutoffs behaves as, server-side. */
const DEFAULT_CUTOFFS: Record<CutoffKey, number> = { session: 90, weekly: 90 };

const currentCutoffs = (key: string): Record<CutoffKey, number> =>
  useSettingsStore.getState().failoverCutoffs[key] ?? DEFAULT_CUTOFFS;

/**
 * Persist one cutoff. Deliberately a module-level function over the store,
 * not a closure over component state: it is called from an unmount cleanup,
 * where the component's state and its setters are already gone.
 */
async function saveCutoff(
  key: string,
  provider: AgentId,
  serviceName: string,
  field: CutoffKey,
  raw: string,
): Promise<void> {
  const value = Number.parseInt(raw, 10);
  // The server validates 1-100 and 400s otherwise; don't send a value the
  // user is still mid-typing (an empty field parses to NaN).
  if (!Number.isInteger(value) || value < 1 || value > 100) return;
  const before = currentCutoffs(key);
  if (value === before[field]) return;
  useSettingsStore.getState().setFailoverCutoffs(key, { ...before, [field]: value });
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failoverCutoffs: { [key]: { [field]: value } } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Roll back only our own optimistic write, and only if it is still the
    // value on screen — a slow failure must not clobber a newer edit or the
    // other field, both of which can land while this request is in flight.
    const now = currentCutoffs(key);
    if (now[field] === value) {
      useSettingsStore.getState().setFailoverCutoffs(key, { ...now, [field]: before[field] });
    }
    // docs/257 req 5. This one is the clearest case for a STORE-held notice
    // rather than component state: `saveCutoff` is deliberately a module-level
    // function over the store because it is called from an unmount cleanup,
    // where the component's state and its setters are already gone. The notice
    // channel is still keyed by harness because cutoffs only ever render on an
    // account-backed mode, which always has one.
    useSettingsStore.getState().setProviderAccountNotice(provider, {
      kind: "error",
      message: `Failed to update ${serviceName} failover cutoff`,
    });
    console.error("[settings] failover cutoff save failed:", err);
  }
}

/**
 * docs/150 reqs 4-6 — the two proactive cutoffs for one `(service, mode)`.
 *
 * Deliberately worded as "start using the next account at N%", not "limit":
 * crossing a cutoff moves *new* work, it does not stop the account working. An
 * account past its cutoff is still used when no account is under one, which is
 * what keeps a low setting from stranding quota.
 *
 * The inputs are controlled by a per-field draft, and a draft commits on Enter,
 * on blur, and — the case that used to lose edits silently — on unmount. These
 * were `defaultValue` + `onBlur` alone, so closing the Settings dialog straight
 * after typing (Escape, the close button, a click outside) unmounted the input
 * without ever firing blur and discarded the edit with no feedback at all.
 *
 * There is deliberately no debounced save-while-typing: it would PUT the "8" on
 * the way to "85", and unmount-commit already covers everything a debounce
 * would have. Nothing pending is left to a timer.
 *
 * A committed draft is cleared, so the field falls back to the store value —
 * which is what makes a failed save's rollback visible rather than sitting
 * behind a stale uncontrolled DOM value.
 */
export function FailoverCutoffControls({
  serviceId,
  billingMode,
  serviceName,
  provider,
}: {
  serviceId: string;
  billingMode: BillingMode;
  serviceName: string;
  /** Only the channel a failed save reports on — see {@link saveCutoff}. */
  provider: AgentId;
}) {
  const key = credentialModeKey(serviceId, billingMode);
  const stored = useSettingsStore((s) => s.failoverCutoffs[key]);
  const cutoffs = stored ?? DEFAULT_CUTOFFS;
  const [drafts, setDrafts] = useState<Partial<Record<CutoffKey, string>>>({});

  // The unmount cleanup and the commit path both need the drafts as of *now*,
  // not as of the render they closed over.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Mount-only, cleanup-only: flushing a pending edit when the control goes
  // away is the whole point, and the identifiers below name which control that
  // is for its entire lifetime.
  // eslint-disable-next-line no-restricted-syntax -- cleanup on unmount; see above
  useEffect(() => () => {
    for (const field of CUTOFF_KEYS) {
      const raw = draftsRef.current[field];
      if (raw !== undefined) void saveCutoff(key, provider, serviceName, field, raw);
    }
  }, [key, provider, serviceName]);

  const commit = (field: CutoffKey) => {
    const raw = draftsRef.current[field];
    if (raw === undefined) return;
    // Drop the draft before saving so a second commit for the same edit (blur
    // right after Enter) is a no-op instead of a duplicate PUT. An invalid or
    // unchanged value is dropped too: nothing was saved, so the field snapping
    // back to the stored number is the honest thing to show.
    const { [field]: _committed, ...rest } = draftsRef.current;
    draftsRef.current = rest;
    setDrafts(rest);
    void saveCutoff(key, provider, serviceName, field, raw);
  };

  const field = (name: CutoffKey, label: string) => (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-(--color-text-secondary)">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={1}
          max={100}
          value={drafts[name] ?? String(cutoffs[name])}
          onChange={(e) => {
            const next = e.target.value;
            setDrafts((current) => ({ ...current, [name]: next }));
          }}
          onKeyDown={(e) => { if (e.key === "Enter") commit(name); }}
          onBlur={() => commit(name)}
          aria-label={`${serviceName} ${label} failover cutoff, percent`}
          className="w-16 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1 text-right text-xs text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
          data-testid={`failover-cutoff-${key}-${name}`}
        />
        <span className="text-(--color-text-tertiary)">%</span>
      </span>
    </label>
  );

  return (
    <div
      className="mt-3 space-y-2 border-t border-dashed border-(--color-border-secondary) pt-3"
      data-testid={`failover-cutoffs-${key}`}
    >
      <p className="text-xs text-(--color-text-tertiary)">
        Start new work on the next account once an account passes these. Accounts past their
        cutoff are still used when no other account is below one, so nothing is stranded.
      </p>
      {field("session", "Short window")}
      {field("weekly", "Weekly")}
    </div>
  );
}
