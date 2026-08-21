import { useState } from "react";
import {
  WarningIcon,
  PlugsIcon,
  KeyIcon,
  GlobeIcon,
  CheckCircleIcon,
  ClockClockwiseIcon,
  XIcon,
  CircleNotchIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePluginReposStore, type PluginHostGrantScope } from "../stores/plugin-repos-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import type { PluginRepoCardView } from "../../server/shared/plugin-repos.js";
import type { EgressHostGrantOutcome } from "../../server/shared/types.js";
import { egressBlockedReason, summarizeEgressGrant } from "./egress-grant-summary.js";
import { RichErrorText } from "./PrLifecycleCard/RichErrorText.js";

/**
 * docs/262 — the Plugins tab pane (plan §3, mockup-plugins-tab.html): one card
 * per declared repo, with the full repo identity always visible (req 19).
 * Renders declarations, self-use, per-repo issues, parse warnings, and each
 * plugin's credential needs (req 23) — an unset key named beside the plugin
 * that needs it, with the one action that closes it. Collision, settings and
 * install problems arrive as ordinary issue rows on the repository's card
 * (verified live in the dogfood instance for all three).
 */
export function PluginReposPanel() {
  const snapshot = usePluginReposStore((s) => s.snapshot);

  if (!snapshot) {
    return <div className="p-4 text-sm text-(--color-text-tertiary)">Loading plugin declarations…</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      {snapshot.warnings.length > 0 && (
        <div className="rounded-lg border border-(--color-border-primary) bg-(--color-warning-subtle) p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-(--color-warning)">
            <WarningIcon size={ICON_SIZE.SM} />
            Declaration problems in shipit.yaml
          </div>
          <ul className="mt-2 space-y-1 text-(--color-text-secondary)">
            {snapshot.warnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {snapshot.repos.map((repo) => (
        <PluginRepoCard key={repo.name} repo={repo} consumerRepoUrl={snapshot.consumerRepoUrl} />
      ))}

      {snapshot.repos.length === 0 && snapshot.warnings.length === 0 && (
        <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-(--color-text-tertiary)">
          <PlugsIcon size={ICON_SIZE.LG} />
          <p>
            This project declares no plugin repositories yet. Add a{" "}
            <code className="font-mono text-xs">plugins:</code> block to shipit.yaml to pull in
            plugins from other repositories.
          </p>
        </div>
      )}
    </div>
  );
}

/** The status chip's words — the card's one-line answer to "is this live?". */
const STATUS_LABEL: Record<PluginRepoCardView["status"], string | null> = {
  // Healthy states carry no chip: the absence of one means "fine" (mock §3).
  self: null,
  active: null,
  activating: "activating…",
  // req 15 — a failed refresh over a live prior version is not "never fetched".
  degraded: "stale",
  unavailable: "unavailable",
};

function PluginRepoCard({
  repo,
  consumerRepoUrl,
}: {
  repo: PluginRepoCardView;
  /** The CONSUMING project's remote — the store "Add key…" must open. */
  consumerRepoUrl: string | null;
}) {
  const isSelf = repo.status === "self";
  const statusLabel = STATUS_LABEL[repo.status];
  // req 23 — every declared credential this repo's plugins lack, kept with the
  // plugin alias that needs it so the row can name the gap.
  const missingKeys = repo.uses.flatMap((u) =>
    (u.credentials ?? []).filter((c) => !c.satisfied).map((c) => ({ alias: u.alias, name: c.name })),
  );
  // req 23 asks the session to show which credentials a plugin requires AND
  // whether they are satisfied — so a set key is stated too, quietly. Only the
  // unsatisfied ones get an action row.
  const setKeys = repo.uses.flatMap((u) =>
    (u.credentials ?? []).filter((c) => c.satisfied).map((c) => ({ alias: u.alias, name: c.name })),
  );
  // req 24 — the same lists for declared external hosts. A host the session may
  // reach is stated quietly, because the requirement asks the session to SHOW
  // what a plugin needs, not only what is broken.
  const allowedHosts = repo.uses.flatMap((u) =>
    (u.hosts ?? []).filter((h) => h.reach === "allowed").map((h) => ({ alias: u.alias, host: h.host })),
  );
  // A gap the user closes deliberately — the only one that may carry a button.
  const grantableHosts = repo.uses.flatMap((u) =>
    (u.hosts ?? []).filter((h) => h.reach === "grantable").map((h) => ({ alias: u.alias, host: h.host })),
  );
  // planning#383 — and a gap NO user act closes: this deployment installs no
  // resolver, or this session admits no user hosts at all. Both buttons would
  // write a durable entry that changes nothing, so the card states the fact
  // instead of offering one. Collapsed into a single row because the reason is a
  // property of the session or the deployment, not of each host: repeating it
  // per host would read as several different problems.
  const ungrantableHosts = repo.uses.flatMap((u) =>
    (u.hosts ?? [])
      .filter((h) => h.reach === "blocked-by-session" || h.reach === "blocked-by-deployment")
      .map((h) => ({ alias: u.alias, host: h.host, reach: h.reach })),
  );
  const blockedReason = ungrantableHosts[0] ? egressBlockedReason(ungrantableHosts[0].reach) : null;
  const needCount = missingKeys.length + grantableHosts.length + ungrantableHosts.length;
  // planning#376 — what the last grant on THIS card took effect on, and the
  // failure if it had one. Both live here rather than in the row that made the
  // grant because the row unmounts on the way out: a success removes the gap the
  // snapshot reported, and so does the 503 "saved, but the live refresh failed
  // closed" — the host is durably allowed there too. An account left on the row
  // goes with it, which is exactly the silence the issue records.
  const [grant, setGrant] = useState<EgressHostGrantOutcome | null>(null);
  const [failedHost, setFailedHost] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-secondary) overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border-primary) px-3 py-2 text-sm">
        <span className="font-semibold">{repo.name}</span>
        {/* req 19 — the repo identity stays visible in every card state. */}
        <Chip mono>{isSelf ? "self · live working tree" : repo.source}</Chip>
        {!isSelf && (
          // A live generation always has a commit; it has a ref unless its
          // record predates ShipIt recording one, and then the commit stands
          // alone rather than borrowing the declared ref (req 19 — the pair has
          // to be one a round produced).
          <Chip mono>
            {repo.ref
              ? `${repo.ref} @ ${repo.commit ? repo.commit.slice(0, 9) : "—"}`
              : repo.commit?.slice(0, 9) ?? "—"}
          </Chip>
        )}
        {statusLabel ? (
          <Chip tone={repo.status === "unavailable" ? "error" : "warn"}>{statusLabel}</Chip>
        ) : (
          // A healthy status still needs a marker when the repo has problems of
          // its own (a selector that names no exported plugin, say) — otherwise
          // the header reads "fine" over a card full of issue rows.
          repo.issues.length > 0 && (
            <Chip tone="warn">{`${repo.issues.length} problem${repo.issues.length > 1 ? "s" : ""}`}</Chip>
          )
        )}
        {/* reqs 23, 24 — an unset credential and an unallowed host are needs,
            not failures: the version is live and whole, one user act away from
            working. They share one chip because they are the same kind of thing
            to the person reading the card — something to go and set. */}
        {needCount > 0 && (
          <Chip tone="warn">{`${needCount} need${needCount > 1 ? "s" : ""}`}</Chip>
        )}
      </div>

      {repo.uses.length > 0 ? (
        <div className="px-3 py-2 text-sm text-(--color-text-secondary)">
          uses{" "}
          {repo.uses.map((u, i) => (
            <span key={u.alias}>
              {i > 0 && " · "}
              <span className="font-medium text-(--color-text-primary)">{u.plugin}</span>
              {u.alias !== u.plugin && (
                <>
                  {" as "}
                  <code className="font-mono text-xs">{u.alias}</code>
                </>
              )}
            </span>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2 text-sm text-(--color-text-tertiary)">
          files only — no plugins activated
        </div>
      )}

      {setKeys.length > 0 && (
        <div
          className="px-3 pb-2 text-xs text-(--color-text-tertiary)"
          data-testid="plugin-credentials-set"
        >
          keys set:{" "}
          {setKeys.map((k, i) => (
            <span key={`${k.alias}:${k.name}`}>
              {i > 0 && " · "}
              <code className="font-mono">{k.name}</code> for {k.alias}
            </span>
          ))}
        </div>
      )}

      {allowedHosts.length > 0 && (
        <div
          className="px-3 pb-2 text-xs text-(--color-text-tertiary)"
          data-testid="plugin-hosts-allowed"
        >
          hosts allowed:{" "}
          {allowedHosts.map((h, i) => (
            <span key={`${h.alias}:${h.host}`}>
              {i > 0 && " · "}
              <code className="font-mono">{h.host}</code> for {h.alias}
            </span>
          ))}
        </div>
      )}

      {/* req 23 — a missing key is a named gap: which plugin, which name, and
          the one action that closes it. "Add key…" opens the CONSUMING
          project's secret store; the plugin repository's own store is never
          what a value is saved into (plan §3). */}
      {missingKeys.map((need) => (
        <div
          key={`${need.alias}:${need.name}`}
          className="flex flex-wrap items-center gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
          data-testid={`plugin-credential-need-${need.alias}-${need.name}`}
        >
          <KeyIcon size={ICON_SIZE.SM} className="flex-none text-(--color-warning)" />
          <span className="min-w-0 break-words">
            <code className="font-mono text-xs">{need.name}</code> is not set for this project —{" "}
            <span className="font-medium">{need.alias}</span> needs it
          </span>
          {consumerRepoUrl && (
            <CardAction
              className="ml-auto"
              onClick={() =>
                useUiStore.getState().setProjectSettingsRepoUrl(consumerRepoUrl, "secrets")
              }
            >
              Add key…
            </CardAction>
          )}
        </div>
      ))}

      {/* req 24 — the same shape for a declared host the session may not reach,
          with the two scopes the requirement names. The declaration itself
          granted nothing: pressing one of these is the deliberate user act. */}
      {grantableHosts.map((need) => (
        <HostNeedRow
          key={`${need.alias}:${need.host}`}
          alias={need.alias}
          host={need.host}
          onGranted={(outcome) => {
            setFailedHost(null);
            setGrant(outcome);
          }}
          onFailed={(host) => {
            setGrant(null);
            setFailedHost(host);
          }}
        />
      ))}

      {/* planning#383 — ONE row for every host no grant can reach, and NO button
          on it, because every button there is a lie. It names the hosts so the
          gap is still visible (req 24's whole point), and says who could change
          it — which is never the person reading the card. */}
      {blockedReason && (
        <div
          className="flex flex-wrap items-start gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
          data-testid="plugin-hosts-ungrantable"
        >
          <GlobeIcon size={ICON_SIZE.SM} className="mt-0.5 flex-none text-(--color-warning)" />
          <div className="min-w-0 flex-1 space-y-0.5 break-words">
            <p className="text-(--color-text-primary)">
              <RichErrorText
                text={`${ungrantableHosts.map((h) => `\`${h.host}\``).join(", ")} — ${blockedReason.headline}`}
                links={false}
              />
            </p>
            <p className="text-xs text-(--color-text-secondary)">{blockedReason.detail}</p>
          </div>
        </div>
      )}

      {grant && <HostGrantOutcomeRow grant={grant} onDismiss={() => setGrant(null)} />}

      {failedHost && (
        <div
          className="flex flex-wrap items-start gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
          data-testid="plugin-host-grant-failed"
        >
          <WarningIcon size={ICON_SIZE.SM} className="mt-0.5 flex-none text-(--color-error)" />
          <p className="min-w-0 flex-1 break-words text-(--color-text-secondary)">
            {/* Deliberately covers both failures with one true sentence: the
                route answers 503 for "saved, but the live refresh failed
                closed", and the browser cannot tell that from a write that
                never landed. */}
            <RichErrorText
              text={`Allowing \`${failedHost}\` failed. It may have been saved without the live refresh — check Settings → Network egress, then try again.`}
              links={false}
            />
          </p>
          <button
            type="button"
            onClick={() => setFailedHost(null)}
            aria-label="Dismiss"
            className="ml-auto flex-none text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
          >
            <XIcon size={ICON_SIZE.SM} />
          </button>
        </div>
      )}

      {repo.issues.map((issue, i) => (
        <div
          key={i}
          className="flex items-start gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
        >
          <WarningIcon size={ICON_SIZE.SM} className="mt-0.5 flex-none text-(--color-warning)" />
          {/* Every issue this feature produces quotes its identifiers in
              backticks — a plugin name, a command, a `overrides.…` path — and
              this row rendered them as literal characters (seen in the dogfood:
              "`probe` declares an install command…"). The same strings are also
              read in a terminal by `shipit plugin refresh`, where backticks are
              right, so the markup stays in the string and the renderer is what
              understands it. `RichErrorText` is the existing one.

              `links={false}` because an issue is not always ShipIt's prose: an
              activation failure carries git's output and a plugin's own install
              stderr, and linkifying those would let a third-party repository
              put an external link into this panel (review finding). */}
          <span className="min-w-0 break-words"><RichErrorText text={issue} links={false} /></span>
        </div>
      ))}

      {!isSelf && repo.status === "active" && (
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          {/* This sentence used to end "…land with the remaining plugin
              mechanics (docs/262)" — the honest placeholder of tab v0, left
              behind once those mechanics shipped, so an ACTIVE card told the
              user its commands, skills and services did not exist yet (found in
              the dogfood).

              It states the CHECKOUT as fact and the rest as following, which is
              the true shape: `emitPluginReposUpdated` pushes the refetch that
              produced this card BEFORE it fire-and-forgets the container
              prepare and the service reconcile (`service-manager-setup.ts`), so
              a card asserting that all four already agree would be asserting
              req 15 rather than reporting it (review finding). Anything that
              could not follow is an issue row above this one. */}
          Checked out at this exact commit. Its files, companion CLIs, skills and services follow
          it — anything that could not be updated is reported above.
        </div>
      )}
      {!isSelf && repo.status === "degraded" && (
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          The prior version stays active — files and commands are unchanged.
        </div>
      )}
      {!isSelf && repo.status === "unavailable" && (
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          The session continues without this repository.
        </div>
      )}
      {isSelf && (
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          This repository's own exports, live from the working tree — services, commands, skills
          and settings, with edits applying without a refresh (req 27).
        </div>
      )}
    </div>
  );
}

/**
 * req 24's affordance: one declared host the session's egress allowlist does
 * not cover, with the two scopes the requirement names — "for the session or
 * for the whole ShipIt instance".
 *
 * The wording states what is true rather than what is convenient. It says the
 * host is not in the allowlist, not that a call was blocked: what enforcement
 * covers differs per execution surface (a plugin service rides the session's
 * containment, a companion-CLI invocation container has its own network), and
 * an allowlist entry is the fact both scopes are about either way.
 *
 * planning#376 — the OUTCOME is reported after the click, by the card
 * (`onGranted`), rather than predicted in these tooltips. The two scopes behave
 * very differently and only the server knows which reload it ran.
 */
function HostNeedRow({
  alias,
  host,
  onGranted,
  onFailed,
}: {
  alias: string;
  host: string;
  onGranted: (outcome: EgressHostGrantOutcome) => void;
  onFailed: (host: string) => void;
}) {
  const allowHost = usePluginReposStore((s) => s.allowHost);
  const [busy, setBusy] = useState(false);

  const grant = async (scope: PluginHostGrantScope) => {
    setBusy(true);
    try {
      const outcome = await allowHost(host, scope);
      if (outcome) onGranted(outcome);
    } catch {
      // Reported to the CARD, not kept here: the snapshot is refetched either
      // way, and on the 503 "saved, but the live refresh failed closed" the host
      // is durably allowed — so this row unmounts and a message on it would go
      // with it, silently (planning#376).
      onFailed(host);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
      data-testid={`plugin-host-need-${alias}-${host}`}
    >
      <GlobeIcon size={ICON_SIZE.SM} className="flex-none text-(--color-warning)" />
      <span className="min-w-0 break-words">
        <code className="font-mono text-xs">{host}</code> is not in this session's egress allowlist —{" "}
        <span className="font-medium">{alias}</span> declares it
      </span>
      <span className="ml-auto flex flex-none items-center gap-2">
        {/* Both tooltips state only WHERE the entry lands, which is a fact
            about the write. Neither predicts which surfaces end up live: the
            old "a running service may need a restart to pick it up" was wrong
            in both directions (the agent is equally stale; a plugin's own
            command container is created per invocation and is allowed at once),
            and any replacement guess would be wrong for an unenforced
            deployment, an Open session, or one with no container. That answer
            is now reported after the click, from the server (planning#376). */}
        <CardAction
          disabled={busy}
          title="Add it to this session's allowlist — this session only. What it took effect on is reported here afterwards."
          onClick={() => void grant("session")}
        >
          Allow for session
        </CardAction>
        <CardAction
          disabled={busy}
          title="Add it to the instance-wide allowlist, for this and future sessions. What it took effect on is reported here afterwards."
          onClick={() => void grant("global")}
        >
          Allow for ShipIt
        </CardAction>
      </span>
    </div>
  );
}

/**
 * planning#376 — the answer to "what did that do?", stated where the act
 * happened. Before this the host row simply vanished on success and the only
 * account of the difference between the two scopes was a `title` tooltip on the
 * button you had already pressed.
 *
 * Every fact here comes from the server's `grant`: it ran the reload (or did
 * not) and can see what is running, so the card reports rather than predicts —
 * the same reason enforcement and this card read one answer.
 *
 * The restart is offered only when the outcome names a session to restart, and
 * never while a turn is running: restarting the container kills the agent.
 */
function HostGrantOutcomeRow({
  grant,
  onDismiss,
}: {
  grant: EgressHostGrantOutcome;
  onDismiss: () => void;
}) {
  const summary = summarizeEgressGrant(grant);
  const api = useApi();
  const agentRunning = useSessionStore((s) => s.isLoading);
  const [restarting, setRestarting] = useState(false);

  const restart = async (sessionId: string) => {
    if (restarting || agentRunning) return;
    setRestarting(true);
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/container/restart`);
      // Re-handshake the WS so the worker reattaches to the freshly-restarted
      // container — the same bridge the session's own network dialog uses.
      window.dispatchEvent(new CustomEvent("shipit:reconnect-ws"));
      useUiStore.getState().setToast({ message: "Restarting the container to apply the allowlist" });
      onDismiss();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      useUiStore.getState().setToast({ message: `Failed to restart container: ${message}` });
      console.error("[plugin-hosts] restart-to-apply failed:", err);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div
      className="flex flex-wrap items-start gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
      data-testid="plugin-host-grant-outcome"
    >
      <span className="mt-0.5 flex-none">
        {summary.kind === "excluded" ? (
          <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning)" />
        ) : summary.kind === "live-everywhere" ? (
          <CheckCircleIcon size={ICON_SIZE.SM} className="text-(--color-success)" />
        ) : (
          <ClockClockwiseIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary)" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5 break-words">
        <p className="text-(--color-text-primary)">
          <RichErrorText text={summary.headline} links={false} />
        </p>
        <p className="text-xs text-(--color-text-secondary)">{summary.detail}</p>
      </div>
      <span className="ml-auto flex flex-none items-center gap-2">
        {summary.restartSessionId && (
          <CardAction
            disabled={agentRunning || restarting}
            title={
              agentRunning
                ? "Wait for the current turn to finish — a restart would kill it"
                : "Restart this session's container so the agent and its services pick up the new allowlist now"
            }
            onClick={() => void restart(summary.restartSessionId!)}
          >
            {restarting ? (
              <CircleNotchIcon size={ICON_SIZE.XS} className="mr-1 inline animate-spin" />
            ) : null}
            Restart to apply now
          </CardAction>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
        >
          <XIcon size={ICON_SIZE.SM} />
        </button>
      </span>
    </div>
  );
}

/** The card's small secondary action — one spelling for every row on it. */
function CardAction({
  children,
  onClick,
  disabled = false,
  title,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(title ? { title } : {})}
      className={`rounded-md border border-(--color-border-primary) px-2 py-1 text-xs hover:bg-(--color-bg-hover) disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function Chip({
  children,
  mono = false,
  tone,
}: {
  children: React.ReactNode;
  mono?: boolean;
  tone?: "warn" | "error";
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${
        tone === "error"
          ? "border-(--color-error) text-(--color-error)"
          : tone === "warn"
            ? "border-(--color-warning) text-(--color-warning)"
            : "border-(--color-border-primary) text-(--color-text-tertiary)"
      } ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}
