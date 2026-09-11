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
 * applies the cutoffs to it (`stringSelectionFor`). GLM's coding plan is the
 * case that proves the rule is about the quota and not the delivery shape: it
 * had no cutoffs while `zai-plan-usage` was a declared id with no reader, and
 * gained them — with no change here — the moment planning#339 built one.
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

// eslint-disable-next-line no-restricted-imports -- unmount flush, see above
import { useEffect, useRef, useState } from "react";
import { loginForProvider } from "./ProviderAccountRows.js";
import type { AgentId } from "../../../server/shared/types.js";
import { credentialModeKey } from "../../../server/shared/types/domain-types/credential-route.js";
import type { BillingMode } from "../../../server/shared/catalogue/index.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { WithTooltip } from "../ui/tooltip.js";

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

const DEFAULT_CUTOFFS: Record<CutoffKey, number> = { session: 90, weekly: 90 };

const currentCutoffs = (key: string): Record<CutoffKey, number> =>
  useSettingsStore.getState().failoverCutoffs[key] ?? DEFAULT_CUTOFFS;

async function saveCutoff(
  key: string,
  provider: AgentId | undefined,
  serviceName: string,
  field: CutoffKey,
  raw: string,
): Promise<void> {
  const value = Number.parseInt(raw, 10);

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

    // value on screen — a slow failure must not clobber a newer edit or the

    const now = currentCutoffs(key);
    if (now[field] === value) {
      useSettingsStore.getState().setFailoverCutoffs(key, { ...now, [field]: before[field] });
    }

    // function over the store because it is called from an unmount cleanup,

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

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

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

    const { [field]: _committed, ...rest } = draftsRef.current;
    draftsRef.current = rest;
    setDrafts(rest);
    void saveCutoff(key, provider, serviceName, field, raw);
  };

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
