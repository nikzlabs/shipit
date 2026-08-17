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
 * **The cutoffs follow the QUOTA, not the delivery shape.** A cutoff is a
 * percentage of a reported quota, so it is offered exactly where one is
 * reported (`modeReportsQuota`) — which is a property of the mode. This used to
 * read "account-backed only", on the belief that only accounts report quota;
 * they do not. A snapshot is recorded per route and gated only on the mode
 * being a subscription, so an Anthropic plan supplied as a token reports its 5h
 * and 7d windows exactly as an account does, and the string-delivered walk now
 * applies the cutoffs to it (`stringSelectionFor`). GLM's coding plan declares
 * `zai-plan-usage`, which has no reader yet (planning#339), so it still gets no
 * cutoffs — the original conclusion, reached for the right reason.
 *
 * **docs/252 req 19 — the band is one row, and none of its copy was deleted.**
 * It was two stacked radios with a hint under each, a dashed rule, and a
 * paragraph over two labelled number fields: five lines of prose for two
 * settings. Compacting it must not cost the sentences, because they are what
 * make the choice answerable — so each moved to the control it was already
 * describing, verbatim:
 *
 * | String | Where it is now |
 * |---|---|
 * | "How ShipIt picks between these {noun}s" | the segmented control's accessible name (`role="radiogroup"`) |
 * | "Use in order" + its hint | tooltip on the first segment, the option's own name as its first line |
 * | "Spread across {noun}s" + its hint | tooltip on the second segment, same shape |
 * | "Start new work on the next account once an account passes these…" | tooltip on both cutoff fields |
 *
 * Only one on-screen *label* shortens — the second segment reads **Spread
 * evenly**, because it sits in a 470px row beside the cutoffs — and its full
 * name leads its own tooltip, so nothing is available only in the short form.
 *
 * `WithTooltip` (Radix) rather than a `title` attribute, because a `title` never
 * opens on keyboard focus: with one, the copy this compaction promised to keep
 * would be unreachable without a mouse. A test asserts all four strings are
 * still reachable from the rendered band.
 */

// useEffect is used solely for its cleanup: a pending cutoff edit must be
// persisted when the control unmounts (closing Settings), which no event
// handler can observe.
// eslint-disable-next-line no-restricted-imports -- unmount flush, see above
import { useEffect, useRef, useState } from "react";
import { loginForProvider } from "./ProviderAccountRows.js";
import type { AgentId } from "../../../server/shared/types.js";
import { credentialModeKey } from "../../../server/shared/types/domain-types/credential-route.js";
import type { BillingMode } from "../../../server/shared/catalogue/index.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { WithTooltip } from "../ui/tooltip.js";

/**
 * A tooltip that leads with the thing's own name.
 *
 * Two of the band's four strings are a name plus an explanation, and the name
 * is the part the shortened on-screen label may have dropped ("Spread evenly"
 * ← "Spread across accounts"). Putting it on a bold first line is what makes
 * the full name still reachable rather than merely implied.
 */
function TitledHint({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="flex max-w-64 flex-col gap-0.5">
      <span className="font-medium text-(--color-text-primary)">{title}</span>
      <span className="text-(--color-text-secondary)">{hint}</span>
    </span>
  );
}

/**
 * docs/150-multiple-provider-subscriptions req 21 — how these credentials relate to each other.
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

  /**
   * One segment. `role="radio"` on a button rather than an `<input type=radio>`
   * so the tooltip has a focusable trigger it can wrap — a native radio inside
   * a `<label>` puts the hover target and the focus target in two places, and
   * Radix would attach to one of them.
   */
  const option = (value: "strict" | "balanced", label: string, fullName: string, hint: string) => (
    <WithTooltip side="top" label={<TitledHint title={fullName} hint={hint} />}>
      <button
        type="button"
        role="radio"
        aria-checked={mode === value}
        disabled={saving}
        onClick={() => void save(value)}
        className={`rounded px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
          mode === value
            ? "bg-(--color-bg-elevated) text-(--color-text-primary) shadow-sm"
            : "text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
        }`}
        data-testid={`credential-selection-mode-${key}-${value}`}
      >
        {label}
      </button>
    </WithTooltip>
  );

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/*
        The band's title, as the group's accessible name. It is announced on
        focus and never drawn — see the module docstring for why it gets no
        tooltip of its own.
      */}
      <div
        role="radiogroup"
        aria-label={`How ShipIt picks between these ${noun}s`}
        className="flex shrink-0 items-center gap-0.5 rounded-md bg-(--color-bg-primary) p-0.5"
        data-testid={`credential-selection-mode-${key}`}
      >
        {option(
          "strict",
          "Use in order",
          "Use in order",
          `New sessions start on the first ${noun} with quota left. Best when they differ — a bigger plan first, a smaller one as backup.`,
        )}
        {option(
          "balanced",
          "Spread evenly",
          `Spread across ${noun}s`,
          `New sessions go to whichever ${noun} has been used least, so quota drains evenly. Best when they are equivalent.`,
        )}
      </div>
      {error && (
        <p className="min-w-0 truncate text-[11px] text-(--color-error)" role="alert">{error}</p>
      )}
    </div>
  );
}

/**
 * The paragraph that used to sit above the two cutoff fields, kept whole as
 * their tooltip. Named because both fields carry the same one — it explains the
 * pair, not either half.
 */
const CUTOFF_EXPLANATION =
  "Start new work on the next account once an account passes these. Accounts past their "
  + "cutoff are still used when no other account is below one, so nothing is stranded.";

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
  provider: AgentId | undefined,
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
    // channel is keyed by LOGIN FLOW — see the block below for what that means
    // when the mode has no login at all.
    /**
     * The notice channel is keyed by LOGIN FLOW, and a string-delivered
     * subscription need not have one — GLM's coding plan is a subscription with
     * no login flow, and Anthropic's plan can arrive as a supplied token on an
     * install with no account. Re-keying the whole notice map by
     * `(service, mode)` is a larger change than this control warrants, so
     * without a login the failure is logged and the field's **rollback** is
     * the feedback: the number visibly snaps back to the stored one, which is
     * the same signal the notice accompanies. Weaker, and stated rather than
     * hidden.
     */
    const loginId = provider ? loginForProvider(provider) : undefined;
    if (loginId) {
      useSettingsStore.getState().setProviderAccountNotice(loginId, {
        kind: "error",
        message: `Failed to update ${serviceName} failover cutoff`,
      });
    }
    console.error("[settings] failover cutoff save failed:", err);
  }
}

/**
 * docs/150-multiple-provider-subscriptions reqs 4-6 — the two proactive cutoffs for one `(service, mode)`.
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
  /**
   * Only the channel a failed save reports on — see {@link saveCutoff}.
   *
   * Optional because the cutoffs are keyed on the MODE reporting a quota, not
   * on the mode being account-backed, and a string-delivered subscription may
   * have no harness to report against.
   */
  provider?: AgentId;
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

  // Inline, and both on the band's one row: the label is the window it names
  // ("5h", "7d" — the same two the quota pill's meters are labelled with, so
  // the number a cutoff is measured against is named the same way on both), and
  // the paragraph they shared is now the tooltip they share.
  const field = (name: CutoffKey, label: string, longLabel: string) => (
    <WithTooltip side="top" label={<TitledHint title={`${longLabel} cutoff`} hint={CUTOFF_EXPLANATION} />}>
      <label className="flex shrink-0 items-center gap-1 text-[11px] text-(--color-text-tertiary)">
        {label}
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
          aria-label={`${serviceName} ${longLabel} failover cutoff, percent`}
          className="w-11 rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-1 py-0.5 text-right text-[11px] text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
          data-testid={`failover-cutoff-${key}-${name}`}
        />
        %
      </label>
    </WithTooltip>
  );

  return (
    <div className="flex items-center gap-2" data-testid={`failover-cutoffs-${key}`}>
      {field("session", "5h", "Short window")}
      {field("weekly", "7d", "Weekly")}
    </div>
  );
}
