import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Spinner } from "./Spinner.js";
// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot /api/oauth/usage fetch when the mobile status dropdown mounts it (external system sync)
import { useCallback, useEffect, useRef, useState } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import { useApi } from "../hooks/useApi.js";
import { Badge } from "./ui/badge.js";
import type {
  CredentialRoute,
  LimitsRefreshOutcome,
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsMap,
  SubscriptionLimitsWindow,
} from "../../server/shared/types.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import {
  credentialStatusWord,
  isUnconnectedAttempt,
  type CredentialStatusWord,
} from "../utils/credential-state.js";
import { serviceLabel } from "../utils/service-label.js";
import {
  allServices,
  modeReportsQuota,
  nativeServiceForHarness,
  subQuotaRefreshable,
} from "../../server/shared/catalogue/index.js";

/**
 * Stable ordering of pills in the header.
 *
 * docs/252 req 10 — one group per `(service, billing mode)` rather than per
 * agent, since quota belongs to a service's subscription and not to the CLI.
 * Only subscription modes appear at all: a key has no allowance and nothing
 * that resets, and req 10 keeps that slot empty rather than showing a
 * placeholder. First-party services keep their historical position so muscle
 * memory works — Claude first, Codex second — with the rest in catalogue order.
 */
function pillOrder(): string[] {
  const first = ["claude", "codex"]
    .map((harness) => nativeServiceForHarness(harness as never))
    .filter((id): id is string => id !== undefined);
  const rest = allServices()
    .map((service) => service.id)
    .filter((id) => !first.includes(id));
  return [...first, ...rest]
    .filter((id) => allServices().some((s) => s.id === id && s.modes.some((m) => m.kind === "sub")))
    .map((id) => `${id}:sub`);
}

/**
 * A known percentage older than this reads as "stale": the number is shown
 * dimmed and the tooltip carries its age. Claude's event numbers refresh on
 * every turn near the limit; the `/api/oauth/usage` number only refreshes on
 * the manual button, so at low usage it can legitimately age.
 */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Fixed window lengths backing the time marker. Claude's short window is 5h
 * and the weekly window is 7d (see `SubscriptionLimitsWindow`). The provider
 * only ever gives us `resetAt`, so the elapsed fraction is derived against
 * these constants — no extra data is fetched.
 */
const SESSION_WINDOW_MS = 5 * 60 * 60_000; // 5h
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000; // 7d

/**
 * Minimum gap between two **automatic** refreshes (`autoRefresh`, i.e. opening
 * the mobile status dropdown). Manual button presses are never throttled here.
 *
 * `/api/oauth/usage` allows only a handful of calls per ~30 min before a 429
 * lockout (docs/161), so the on-open fetch is rate-limited client-side: at
 * worst 6 automatic calls per 30 minutes, which stays inside the budget. A
 * reading up to 5 minutes old is also well inside `STALE_AFTER_MS`, so a
 * throttled open still shows a number the user reads as current.
 */
export const AUTO_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Last refresh attempt per **route**, module-scoped so it survives the
 * mount/unmount cycle of the popover that hosts the pill (Radix unmounts
 * `PopoverContent` on close, so component state can't carry the throttle).
 *
 * Keyed by route, not by provider: the upstream budget is per subscription, and
 * a provider-keyed throttle meant the second account's pill was silently
 * skipped on every dropdown open — it never got its own baseline reading.
 */
const lastRefreshAttemptAt = new Map<string, number>();

/** Test seam — clears the module-level auto-refresh throttle between cases. */
export function resetAutoRefreshThrottle(): void {
  lastRefreshAttemptAt.clear();
}

interface SubscriptionLimitsBadgeProps {
  limits: SubscriptionLimitsMap;
  /**
   * Fetch fresh usage once when this badge mounts (throttled by
   * `AUTO_REFRESH_MIN_INTERVAL_MS`). Set by the mobile status dropdown, whose
   * `PopoverContent` mounts on open — opening it *is* the user asking for the
   * number, so it spends a call the same way the refresh button does, without
   * requiring a second tap on a surface that has no hover tooltip.
   */
  autoRefresh?: boolean;
}

/**
 * Header badge group rendering one **pill per connected subscription** plus a
 * refresh button, on the services whose quota can be re-read on demand
 * (`subQuotaRefreshable`). See docs/161 and
 * docs/135-subscription-limits-badge/plan.md.
 *
 * docs/150-multiple-provider-subscriptions req 10 — quota is per account, so a provider with two connected
 * subscriptions gets two pills, each labelled with that account's name.
 *
 * The name is shown whenever the route IS an account, unconditionally. An
 * earlier version suppressed it for the single-pill case, on the theory that a
 * name only earns its space when it disambiguates. That was wrong twice over:
 * req 10 asks for the account name outright, and — worse — the condition
 * counted *snapshots*, not accounts. Routes with no snapshot are omitted from
 * the map, so a user with two connected accounts where only one had ever
 * reported quota saw a single pill labelled "Claude", indistinguishable from
 * the one-account case and silent about which subscription it described.
 *
 * Reserved env / API-key routes are not accounts and keep the provider label.
 */
export function SubscriptionLimitsBadge({ limits, autoRefresh }: SubscriptionLimitsBadgeProps) {
  const accounts = useSettingsStore((s) => s.providerAccounts);
  const routes = useSettingsStore((s) => s.credentialRoutes);
  const pills = buildPills(limits, accounts, routes);
  if (pills.length === 0) return null;

  return (
    <>
      {pills.map(({ key, serviceId, routeId, label, snapshot, attention }) => (
        <SubscriptionLimitPill
          key={key}
          serviceId={serviceId}
          routeId={routeId}
          label={label}
          snapshot={snapshot}
          {...(attention ? { attention } : {})}
          // Only a service whose quota can be re-read on demand gets a button
          // (planning#339). Codex's numbers are pushed during a turn and can
          // only be received, so a button there would spin and change nothing.
          // Asked of the catalogue rather than written out as `=== "anthropic"`,
          // which is what left this and the two Settings rows to be found and
          // changed by hand when GLM's reader landed.
          showRefresh={subQuotaRefreshable(serviceId)}
          autoRefresh={autoRefresh}
        />
      ))}
    </>
  );
}

interface SubscriptionPill {
  key: string;
  serviceId: string;
  routeId: string;
  label: string;
  snapshot?: SubscriptionLimits;
  attention?: CredentialStatusWord;
}

/**
 * How many pills the header would render right now.
 *
 * Exported because the header has to size its own layout around the answer
 * (docs/150): each connected account adds a full pill, and past two or three of
 * them the row stops fitting beside the logo. `AppLayout` reads the count to
 * decide whether the status group renders inline or collapses into the status
 * dropdown.
 */
export function useSubscriptionPillCount(limits: SubscriptionLimitsMap): number {
  const accounts = useSettingsStore((s) => s.providerAccounts);
  const routes = useSettingsStore((s) => s.credentialRoutes);
  return buildPills(limits, accounts, routes).length;
}

function buildPills(
  limits: SubscriptionLimitsMap,
  accounts: CredentialRoute[],
  /**
   * Every credential the user holds — the superset that also carries the
   * **supplied secrets** (an env-delivered token, a pasted plan key), which are
   * not provider-account rows and so are absent from `accounts`. Read only for
   * their state: what a supplied secret's pill says, and whether it gets one at
   * all when it has never reported a quota.
   */
  routes: CredentialRoute[],
): SubscriptionPill[] {
  const pills: SubscriptionPill[] = [];
  for (const modeKey of pillOrder()) {
    const serviceId = modeKey.slice(0, modeKey.lastIndexOf(":"));
    const byRoute = limits[modeKey];
    /*
      docs/274 req 16 — a subscription ShipIt has no reader for gets no METERS.
      Without this the two windows render as `5h · —  7d · —` forever, with no
      refresh button beside them (`subQuotaRefreshable` is already false), which
      is a pill that looks broken rather than one that says nothing: the user
      who reported it read the blanks as "ShipIt lost my numbers". They are not
      pending — OpenCode Go's vendor publishes no per-key usage API, so nothing
      will ever fill them. The Settings credential row reached this conclusion first
      (`ServicesPanel`, `modeReportsQuota` rather than `billingMode === "sub"`):
      an empty pill says "no usage" where the truth is "not measured".

      Gated per mode rather than in `pillOrder`, because the pill still has a
      second job that has nothing to do with quota — see the `attention` skip
      below.
    */
    const reportsQuota = modeReportsQuota(serviceId, "sub");
    // planning#342 — an account row IS a credential of its service now, so
    // the pill matches on the service directly instead of mapping the row's
    // harness back to one.
    // A row that has never been anything but a sign-in attempt is not a
    // credential yet ({@link isUnconnectedAttempt}), and the header must ask
    // the same question Settings asks — a row exists from the instant *Sign
    // in* is pressed and is deleted again if the user backs out. Without the
    // test, starting a sign-in put a pill in the header saying the account
    // needs reconnecting, about an account that was never connected.
    const modeAccounts = accounts.filter(
      (account) => account.serviceId === serviceId && !isUnconnectedAttempt(account),
    );

    // Among the modes that report a quota at all, connected accounts define
    // pill presence, not cached snapshots. A quiet account may have no quota
    // event yet, but its pill must remain available so the user can request a
    // refresh and see that usage is still unknown. That argument is what the
    // gate above bounds: it holds only where a refresh can produce a number.
    for (const account of modeAccounts) {
      // ...and the second job: a credential that cannot run a turn says so
      // here, which is a statement about the SIGN-IN and not about quota. So a
      // no-reader subscription keeps that pill and loses only the meters — an
      // xAI account needing reconnection is exactly as worth saying as an
      // Anthropic one, and this is the only place the header says it.
      if (!reportsQuota && !credentialStatusWord(account)) continue;
      pills.push({
        key: `${modeKey}:${account.id}`,
        serviceId,
        routeId: account.id,
        label: account.label,
        snapshot: byRoute?.[account.id],
        // A credential that cannot authenticate a turn has no quota worth
        // reading, and the pill is the only place the header says anything
        // about an account at all — so the state travels with it.
        ...(credentialStatusWord(account) ? { attention: credentialStatusWord(account) } : {}),
      });
    }

    // A supplied secret of this same subscription — `ANTHROPIC_AUTH_TOKEN`,
    // GLM's coding-plan key. Not an account, so `accounts` does not hold it and
    // the label stays the service's rather than inventing a name for something
    // the user never named; but it IS a credential with a state, and planning#358
    // records a provider refusing one exactly as it records a failed login.
    const modeSecrets = new Map(
      routes
        .filter((r) => r.serviceId === serviceId && r.billingMode === "sub" && r.via === "string")
        .map((r) => [r.id, r] as const),
    );

    // Reserved routes are not provider-account rows, so a snapshot is normally
    // the only evidence that they exist. Append them after the user's account
    // order.
    const fromSnapshot = new Set<string>();
    for (const snapshot of Object.values(byRoute ?? {})) {
      if (modeAccounts.some((account) => account.id === snapshot.routeId)) continue;
      fromSnapshot.add(snapshot.routeId);
      const secret = modeSecrets.get(snapshot.routeId);
      const secretAttention = secret ? credentialStatusWord(secret) : undefined;
      // Unreachable today and still worth writing: a mode with no reader has no
      // `LimitsProvider`, so no snapshot of it can exist. But this loop derives
      // a pill FROM a snapshot, so it would render one on nothing but the map's
      // say-so — and a stale entry, or a service that loses a reader, would put
      // the blank meters straight back. The rule is "no reader, no meters", and
      // the code says it in every loop rather than in one loop and a doc.
      if (!reportsQuota && !secretAttention) continue;
      pills.push({
        key: `${modeKey}:${snapshot.routeId}`,
        serviceId,
        routeId: snapshot.routeId,
        label: serviceLabel(serviceId),
        snapshot,
        ...(secretAttention ? { attention: secretAttention } : {}),
      });
    }

    // ...and "normally" is the hole: a refused secret whose turns all failed may
    // have no snapshot at all, and then the header said nothing whatsoever about
    // the credential every turn was dying on. A supplied secret is `ready` from
    // the moment it is stored, so this adds a pill only for one the provider has
    // actually refused — never a second pill for a healthy one.
    for (const secret of modeSecrets.values()) {
      if (fromSnapshot.has(secret.id)) continue;
      const attention = credentialStatusWord(secret);
      if (!attention) continue;
      pills.push({
        key: `${modeKey}:${secret.id}`,
        serviceId,
        routeId: secret.id,
        label: serviceLabel(serviceId),
        attention,
      });
    }
  }
  return pills;
}

interface SubscriptionLimitPillProps {
  serviceId?: string;
  /**
   * The subscription this pill describes — a provider-account id or a reserved
   * route id. Scopes the refresh to this account so one press costs one
   * upstream call instead of one per connected account.
   */
  routeId?: string;
  /**
   * Whose quota this is — omitted where the surrounding row already says so.
   *
   * In the header a pill floats free and must name its account (docs/150 req
   * 10). On a Settings → Services credential row (docs/252 req 19) the row IS
   * the account's name, and repeating it inside the pill spends the width the
   * compaction was for. The pill is otherwise identical, deliberately: the
   * meters, the elapsed-time marker, the staleness dimming and the refresh
   * button are one implementation, not a second read-out that can disagree.
   */
  label?: string;
  snapshot?: SubscriptionLimits;
  showRefresh?: boolean;
  /** See `SubscriptionLimitsBadgeProps.autoRefresh`. Only acts with `showRefresh`. */
  autoRefresh?: boolean;
  /**
   * This credential needs the user before it can run a turn — from
   * {@link credentialStatusWord}. Present ⇒ the pill says so **instead of**
   * showing meters (see {@link CredentialAttention}).
   *
   * Omitted by the Settings credential row, which prints the same word itself
   * one element to the left and hides the pill entirely for a non-ready
   * credential. The header has no such row, so there the pill carries it.
   */
  attention?: CredentialStatusWord;
}

/**
 * Which of the two meters this pill draws — **the windows the plan has**, never
 * a fixed pair (planning#454).
 *
 * The pill drew both slots for every subscription, on the assumption that every
 * plan has a 5-hour window and a weekly one. Several do not. SuperGrok has a
 * single weekly pool and no short window at all; the user reporting this also
 * had a ChatGPT plan and a GLM plan whose readings carry no 5-hour figure. All
 * three rendered a `5h · —` that nothing could ever fill, beside a real weekly
 * number — the same permanently-empty read-out as the pill this feature was
 * opened to fix, just one slot narrower.
 *
 * **No service is named here, and the answer is not inferred here either.** The
 * provider states it (`SubscriptionLimits.availableWindows`), because only the
 * provider can. Deriving it from a null window was tried first and is WRONG:
 * Claude's `rate_limit_event` carries one window per event, so the first
 * reading of a session has the other side null on a plan that has both, and
 * this function would have dropped a real 7d meter for the whole of that turn —
 * longer if the `/api/oauth/usage` seed had been 429'd. A null window means
 * "absent" from a reader whose payload describes the whole plan and "not yet"
 * from one whose readings arrive piecemeal, and nothing at this end can tell
 * those apart.
 *
 * Silence therefore means "draw everything": a provider that says nothing is
 * treated as making no claim, so Claude's pill is untouched and a reading that
 * carries only a lockout countdown still shows both slots pending — which the
 * refresh button beside them can still make false.
 */
export function windowsShown(
  snapshot: SubscriptionLimits | undefined,
): { session: boolean; weekly: boolean } {
  const declared = snapshot?.availableWindows;
  if (declared === undefined || declared.length === 0) return { session: true, weekly: true };
  return { session: declared.includes("session"), weekly: declared.includes("weekly") };
}

export function SubscriptionLimitPill({ serviceId, routeId, label, snapshot, showRefresh, autoRefresh, attention }: SubscriptionLimitPillProps) {
  const now = Date.now();
  const resolvedServiceId = snapshot?.serviceId ?? serviceId;
  const resolvedRouteId = routeId ?? snapshot?.routeId;
  const shows = windowsShown(snapshot);

  // A broken credential's meters are worse than nothing: the numbers are real
  // but frozen at whatever the account last reported, so the pill reads
  // "healthy, 30% used" while every turn on that account is being refused. The
  // user's report was exactly this — the pills worked, the commands did not,
  // and only Settings knew why. So the state replaces the numbers rather than
  // sitting beside them, and the refresh button goes with them: there is
  // nothing to fetch until the sign-in is redone.
  if (attention) {
    return (
      <Badge numeric className="gap-2 pl-2 pr-2 pt-0 pb-0.5 bg-(--color-bg-hover) min-w-0">
        {label !== undefined && (
          <span className="truncate" title={label}>
            {label}
          </span>
        )}
        <CredentialAttention attention={attention} />
      </Badge>
    );
  }

  // The pill carries inline meters with underline gauges, so it overrides
  // Badge's symmetric padding with the asymmetric `pl-2 pr-* pt-0 pb-0.5` it
  // needs (tighter right edge when the refresh button is tucked in) and adds
  // the `gap-2` flex spacing between label / meters / button.
  return (
    // `min-w-0` is what lets a header row of pills give ground instead of
    // overflowing (docs/150): a flex item defaults to `min-width: auto`, so
    // without it three account pills refused to shrink and pushed the header's
    // trailing controls off-screen. The meters and refresh button stay at their
    // natural width — the account label is the only part that yields, and it
    // truncates with its full value still in the tooltip.
    <Badge
      numeric
      className={`gap-2 pl-2 ${showRefresh ? "pr-1" : "pr-2"} pt-0 pb-0.5 bg-(--color-bg-hover) min-w-0`}
    >
      {label !== undefined && (
        <span className="truncate" title={snapshot?.plan ? `${label} — ${snapshot.plan}` : label}>
          {label}
        </span>
      )}
      {shows.session && (
        <Meter
          shortLabel="5h"
          longLabel="5h window"
          window={snapshot?.session ?? null}
          windowMs={SESSION_WINDOW_MS}
          fetchedAt={snapshot?.fetchedAt}
          now={now}
        />
      )}
      {shows.weekly && (
        <Meter
          shortLabel="7d"
          longLabel="7d window"
          window={snapshot?.weekly ?? null}
          windowMs={WEEKLY_WINDOW_MS}
          fetchedAt={snapshot?.fetchedAt}
          now={now}
        />
      )}
      {showRefresh && resolvedServiceId && (
        <LimitsRefreshButton
          serviceId={resolvedServiceId}
          routeId={resolvedRouteId}
          lockedUntil={snapshot?.lockedUntil}
          autoRefresh={autoRefresh}
        />
      )}
    </Badge>
  );
}

/**
 * The attention word inside a header pill, and the way out of the state it
 * names: pressing it opens Settings → Services, where the credential's remedy
 * lives — *Reconnect* for an account, *Replace* for a supplied secret.
 *
 * It is a button rather than a label because the alternative is a dead end —
 * the whole failure this fixes is a user who could see that something was
 * wrong only after going looking for it. The word is the same one the Settings
 * row says ({@link credentialStatusWord}), so the two surfaces cannot disagree
 * about what is wrong or about what to do next.
 */
function CredentialAttention({ attention }: { attention: CredentialStatusWord }) {
  return (
    <button
      type="button"
      onClick={() => {
        useUiStore.getState().setSettingsTab("services");
        useUiStore.getState().setSettingsOpen(true);
      }}
      className={`inline-flex items-center gap-1 whitespace-nowrap hover:underline ${
        attention.tone === "error" ? "text-(--color-error)" : "text-(--color-warning)"
      }`}
      title="Open Settings → Services to fix this credential"
      data-credential-attention={attention.text}
    >
      <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
      {attention.text}
    </button>
  );
}

interface MeterProps {
  shortLabel: string;
  longLabel: string;
  window: SubscriptionLimitsWindow | null;
  /** Fixed length of this window in ms (5h / 7d) — drives the time marker. */
  windowMs: number;
  fetchedAt?: number;
  now: number;
}

/**
 * Fraction of the window already elapsed (0–100), derived from the fixed
 * window length: the window started at `resetAt − windowMs`, so elapsed =
 * `now − start`. Returns `null` when `resetAt` is unparseable so the marker
 * is simply omitted rather than drawn at a bogus position.
 *
 * This is the second dimension the pill was missing: "48% used" reads very
 * differently on day 1 of the week than on day 6. The marker shows where the
 * clock is, so quota-vs-time pace is legible at a glance — fill short of the
 * marker means you're under pace, fill past it means you're burning quota
 * faster than the window is elapsing.
 */
export function timeElapsedPct(
  resetAt: string,
  windowMs: number,
  now: number,
  startedAt?: string,
): number | null {
  const startMs = startedAt === undefined ? Date.parse(resetAt) - windowMs : Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const pct = ((now - startMs) / windowMs) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

type MeterDisplay =
  | { kind: "known"; pct: number; stale: boolean }
  | { kind: "reset" }
  | { kind: "unknown" };

/**
 * Classify how a window should render. The three "no live number" flavors are
 * deliberately distinct (docs/161): a window whose reset has elapsed reads as
 * **reset** (rolled over — the cached number is meaningless), a window the
 * provider never gave a number for reads as **unknown** (`—`), and a known
 * number older than `STALE_AFTER_MS` reads as **known but stale** (dimmed).
 */
export function meterDisplay(
  window: SubscriptionLimitsWindow,
  fetchedAt: number,
  now: number,
): MeterDisplay {
  const resetMs = Date.parse(window.resetAt);
  const elapsed = !Number.isNaN(resetMs) && resetMs <= now;
  if (elapsed) return { kind: "reset" };
  if (window.usedPct === null) return { kind: "unknown" };
  return { kind: "known", pct: window.usedPct, stale: now - fetchedAt > STALE_AFTER_MS };
}

/**
 * A single 5h / 7d meter. Known windows render the tier-colored `"5h NN%"`
 * with a thin underline gauge (dimmed when stale). Reset and unknown windows
 * render an explicit muted label instead of a percentage so the user can tell
 * "ShipIt doesn't know this number" from "it's 42%" at a glance — the old
 * behavior of showing a bare reset countdown looked like real data when it
 * wasn't (docs/161). The reset time itself moves to the tooltip in those
 * states.
 */
function Meter({ shortLabel, longLabel, window, windowMs, fetchedAt, now }: MeterProps) {
  const title = window
    ? `${formatWindowLine(longLabel, window, now)}${fetchedAt === undefined ? "" : `\nUpdated ${formatAge(fetchedAt, now)}`}`
    : `${longLabel}: usage not reported yet${fetchedAt === undefined ? "" : `\nUpdated ${formatAge(fetchedAt, now)}`}`;

  if (!window) {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="unreported"
        title={title}
      >
        {shortLabel} · —
      </span>
    );
  }

  const display = meterDisplay(window, fetchedAt ?? 0, now);

  if (display.kind === "reset") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="reset"
        title={title}
      >
        {shortLabel} · reset
      </span>
    );
  }

  if (display.kind === "unknown") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="unknown"
        title={title}
      >
        {shortLabel} · —
      </span>
    );
  }

  const pct = display.pct;
  const fillWidth = `${Math.max(0, Math.min(100, pct))}%`;
  const color = tierColor(pct);
  const countdown = pct > 90 ? formatResetCountdown(window.resetAt, now) : null;
  const elapsedPct = timeElapsedPct(window.resetAt, windowMs, now, window.startedAt);
  // The marker lives INSIDE this wrapper, so the `opacity-50` stale dimming
  // above cascades to it automatically — a stale meter fades the time marker
  // along with its number and fill.
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap${display.stale ? " opacity-50" : ""}`}
      data-meter-pct={Math.round(pct)}
      style={{ color }}
      title={title}
    >
      <span className="relative inline-flex pb-0.5" data-meter-value>
        {shortLabel} {formatPct(pct)}
        <span
          aria-hidden
          data-meter-track
          className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-(--color-text-secondary)/25"
        >
          <span
            aria-hidden
            data-meter-fill
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: fillWidth, backgroundColor: color }}
          />
          {elapsedPct !== null && (
            <span
              aria-hidden
              data-time-marker
              className="absolute -top-[1px] -bottom-[1px] w-0.5 -translate-x-1/2 rounded-full bg-(--color-text-primary)"
              style={{ left: `${elapsedPct}%` }}
            />
          )}
        </span>
      </span>
      {countdown && <span className="ml-1 text-(--color-text-secondary)">resets in {countdown}</span>}
    </span>
  );
}

/**
 * Explanations for the outcomes a refresh can end on without producing new
 * numbers. Shown in the button's tooltip — the whole point is that a press
 * which changes nothing on screen still says why.
 *
 * planning#339 — named after the service rather than hard-coded to "Anthropic",
 * now that GLM's plan has a reader too: a GLM pill reporting that *Anthropic*
 * rate-limited it names the wrong vendor and sends the user to the wrong place.
 * The two outcomes that are about the *credential* rather than the vendor say
 * "credential", because it can be either a sign-in or a pasted key.
 */
function outcomeMessage(outcome: LimitsRefreshOutcome, serviceName: string): string | null {
  switch (outcome) {
    case "updated":
    case "skipped":
      return null;
    case "locked":
    case "rate-limited":
      return `Usage refresh rate-limited by ${serviceName}`;
    case "no-credentials":
      return "This credential has no usable sign-in or key — fix it in Settings";
    case "expired-token":
      return "This credential's sign-in expired — reconnect it in Settings";
    case "failed":
      return `Couldn't reach ${serviceName}'s usage endpoint`;
    case "unavailable":
      return "Usage refresh isn't available for this credential";
  }
}

/**
 * Per-subscription refresh button. Fires one on-demand `/api/oauth/usage` fetch
 * for **this pill's route** via `POST /api/limits/refresh`; the server is
 * single-flight and 429-lockout-guarded, and the numbers return over the
 * `subscription_limits` SSE broadcast. While `lockedUntil` is in the future the
 * button is disabled with a countdown so it can't re-trip the upstream rate
 * limit (docs/161).
 *
 * Sending `routeId` is load-bearing, not tidiness. Without it the server fans
 * the fetch out over every connected account, so with two subscriptions each
 * press spent both accounts' share of a budget that allows only a handful of
 * calls per ~30 min — pressing the pill that showed no numbers was the fastest
 * way to lock out the pill that did.
 *
 * A failed attempt is reported, not swallowed. Every non-success path in the
 * provider is a silent early return, so the previous "swallow, the SSE is the
 * source of truth" left a button that spun and did nothing with no way to tell
 * a rate-limit from a signed-out account.
 *
 * With `autoRefresh` the same fetch also fires once on mount — the mobile
 * status dropdown opens straight into fresh numbers instead of requiring a tap
 * on the glyph. The button stays for an explicit re-fetch (and so a throttled
 * open still has an override), and shows its spinner for either trigger since
 * both go through this component's state.
 */
function LimitsRefreshButton({
  serviceId,
  routeId,
  lockedUntil,
  autoRefresh,
}: {
  serviceId: string;
  routeId?: string;
  lockedUntil?: number;
  autoRefresh?: boolean;
}) {
  const api = useApi();
  const serviceName = serviceLabel(serviceId);
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const now = Date.now();
  const locked = lockedUntil !== undefined && lockedUntil > now;
  const lockCountdown = locked
    ? formatResetCountdown(new Date(lockedUntil).toISOString(), now)
    : null;

  const throttleKey = `${serviceId}:sub:${routeId ?? "*"}`;

  const refresh = useCallback(async () => {
    lastRefreshAttemptAt.set(throttleKey, Date.now());
    setRefreshing(true);
    try {
      const res = await api.post<{ ok: boolean; results?: LimitsRefreshResult[] }>(
        "/api/limits/refresh",
        // Only a subscription reports a quota (req 10), so the pill can only
        // ever be asking about the `sub` mode.
        routeId ? { serviceId, billingMode: "sub", routeId } : { serviceId, billingMode: "sub" },
      );
      // Report on this pill's own route when the response names it; a fan-out
      // response (no routeId sent) has no single owner, so fall back to the
      // first result rather than attributing another account's failure here.
      const mine = res.results?.find((r) => r.routeId === routeId) ?? res.results?.[0];
      setProblem(mine ? outcomeMessage(mine.outcome, serviceName) : null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Usage refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [api, routeId, serviceId, serviceName, throttleKey]);

  // Fire-once-on-mount auto refresh. The ref (not the throttle map) is what
  // makes it once-per-mount: the map only bounds how often *any* mount is
  // allowed to spend a call, and a locked-out route is skipped entirely
  // rather than firing a request the server would no-op.
  const autoFired = useRef(false);
  // eslint-disable-next-line no-restricted-syntax -- mount IS the event here: Radix unmounts PopoverContent on close, so this component mounting is the dropdown opening, and the fetch is an external-system sync with no event-handler equivalent.
  useEffect(() => {
    if (!autoRefresh || autoFired.current) return;
    autoFired.current = true;
    if (locked) return;
    const last = lastRefreshAttemptAt.get(throttleKey) ?? 0;
    if (Date.now() - last < AUTO_REFRESH_MIN_INTERVAL_MS) return;
    void refresh();
  }, [autoRefresh, locked, refresh, throttleKey]);

  // The lockout countdown is the more specific message when both are present:
  // it carries a retry time, and it is broadcast state rather than the result
  // of one press, so it survives a remount.
  const title = locked
    ? `Usage refresh rate-limited — retry in ${lockCountdown}`
    : problem ?? `Refresh usage from ${serviceName}`;

  const failed = !locked && problem !== null;

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={refreshing || locked}
      className={`inline-flex items-center justify-center rounded-full -ml-1 p-1 translate-y-px transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-40 ${
        failed ? "text-(--color-context-high)" : "text-(--color-text-secondary)"
      }`}
      title={title}
      aria-label="Refresh subscription usage"
      data-refresh-problem={problem ?? undefined}
    >
      {refreshing ? (
        <Spinner size={ICON_SIZE.XS} />
      ) : failed ? (
        <WarningCircleIcon size={ICON_SIZE.XS} />
      ) : (
        <ArrowClockwiseIcon size={ICON_SIZE.XS} />
      )}
    </button>
  );
}

/**
 * Tier color for a usage percentage: neutral → mid → high → full at
 * 60 / 75 / 90 percent. Returns a `var(--color-context-*)` string so
 * the same value drives both the meter text and its fill bar; below
 * 60% the meter stays at the neutral `--color-text-secondary` so it
 * reads the same as the provider label.
 */
export function tierColor(pct: number): string {
  if (pct >= 90) return "var(--color-context-full)";
  if (pct >= 75) return "var(--color-context-high)";
  if (pct >= 60) return "var(--color-context-mid)";
  return "var(--color-text-secondary)";
}

/** Format 0–100 → `"96%"`, rounded to whole-number percent. */
export function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

export function formatResetCountdown(iso: string, nowMs = Date.now()): string {
  const resetMs = Date.parse(iso);
  if (Number.isNaN(resetMs)) return iso;
  const diffMs = resetMs - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";

  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours === 0) return `${days}d`;
  return `${days}d ${hours}h`;
}

/** Compact "N min ago" / "just now" for a snapshot age. */
export function formatAge(fetchedAt: number, nowMs = Date.now()): string {
  const diffMs = nowMs - fetchedAt;
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatWindowLine(label: string, window: SubscriptionLimitsWindow, now: number): string {
  const resetMs = Date.parse(window.resetAt);
  const elapsed = !Number.isNaN(resetMs) && resetMs <= now;
  if (elapsed) return `${label}: just reset — refresh to update`;
  if (window.usedPct === null) {
    return `${label}: usage not reported — click refresh to fetch (resets ${formatReset(window.resetAt)})`;
  }
  const src = window.source === "usage-api" ? " · from /usage" : "";
  return `${label}: ${formatPct(window.usedPct)} used (resets ${formatReset(window.resetAt)})${src}`;
}

function formatReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
