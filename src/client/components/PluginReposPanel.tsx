import { useState } from "react";
import { Spinner } from "./Spinner.js";
import {
  WarningIcon,
  PlugsIcon,
  KeyIcon,
  GlobeIcon,
  CheckCircleIcon,
  ClockClockwiseIcon,
  ArrowsClockwiseIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  usePluginReposStore,
  type PluginHostGrantScope,
  type PluginRepoRefreshOutcome,
} from "../stores/plugin-repos-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import type { PluginRepoCardView } from "../../server/shared/plugin-repos.js";
import type { EgressHostGrantOutcome, EgressHostReach } from "../../server/shared/types.js";
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
 *
 * req 12's USER half lives here too: a tracked repository's card carries the
 * Refresh action, on the same route and the same round `shipit plugin refresh`
 * runs. A pinned one deliberately does not (req 8).
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
  // reqs 23, 24 — every declared credential and host, kept with the plugin
  // alias that declares it so each row can name the claimant.
  const keys = repo.uses.flatMap((u) => (u.credentials ?? []).map((c) => ({ alias: u.alias, ...c })));
  const hosts = repo.uses.flatMap((u) => (u.hosts ?? []).map((h) => ({ alias: u.alias, ...h })));
  // Every declared credential this repo's plugins LACK and cannot work without.
  const missingKeys = keys.filter((c) => !c.satisfied && !c.optional);
  // A key the plugin can use and does not need. Shown — a silent omission would
  // leave "why is this plugin not doing the thing?" unanswerable — but not as a
  // need: the project may have decided never to set it, and an alarm that
  // cannot be cleared is one the reader learns to ignore.
  const optionalKeys = keys.filter((c) => !c.satisfied && c.optional);
  // req 23 asks the session to show which credentials a plugin requires AND
  // whether they are satisfied — so a set key is stated too, quietly. Only the
  // unsatisfied ones get an action row. A set key reads the same either way:
  // optionality is about the unsatisfied state alone.
  const setKeys = keys.filter((c) => c.satisfied);
  // req 24 — the same lists for declared external hosts. A host the session may
  // reach is stated quietly, because the requirement asks the session to SHOW
  // what a plugin needs, not only what is broken.
  const allowedHosts = hosts.filter((h) => h.reach === "allowed");
  // A gap the user closes deliberately — the only one that may carry a button.
  const grantableHosts = hosts.filter((h) => h.reach === "grantable" && !h.optional);
  // planning#383 — and a gap NO user act closes: this deployment installs no
  // resolver, or this session admits no user hosts at all. Both buttons would
  // write a durable entry that changes nothing, so the card states the fact
  // instead of offering one. Collapsed into a single row because the reason is a
  // property of the session or the deployment, not of each host: repeating it
  // per host would read as several different problems.
  const ungrantableHosts = hosts.filter(
    (h) => !h.optional && (h.reach === "blocked-by-session" || h.reach === "blocked-by-deployment"),
  );
  // The optional half of both, in one list: a host the plugin can use and the
  // session does not reach. It keeps its grant affordance where a grant would
  // work — the user may still want it — and states the blocking reason where
  // one would not, for the same reason the required row does.
  const optionalHosts = hosts.filter((h) => h.optional && h.reach !== "allowed");
  const blockedReason = ungrantableHosts[0] ? egressBlockedReason(ungrantableHosts[0].reach) : null;
  // Optional gaps are deliberately NOT counted: the chip means "something to go
  // and set", and a count that never reaches zero however much the user sets is
  // a chip that stops meaning anything.
  const needCount = missingKeys.length + grantableHosts.length + ungrantableHosts.length;
  // planning#376 — what the last grant on THIS card took effect on, and the
  // failure if it had one. Both live here rather than in the row that made the
  // grant because the row unmounts on the way out: a success removes the gap the
  // snapshot reported, and so does the 503 "saved, but the live refresh failed
  // closed" — the host is durably allowed there too. An account left on the row
  // goes with it, which is exactly the silence the issue records.
  const [grant, setGrant] = useState<EgressHostGrantOutcome | null>(null);
  const [failedHost, setFailedHost] = useState<string | null>(null);
  // req 12 — the user's half of the refresh verb. The outcome lives on the CARD
  // for the reason the grant outcome does: `unchanged` changes nothing visible,
  // so without a reported answer the button would look broken exactly when it
  // worked.
  const refreshRepo = usePluginReposStore((s) => s.refreshRepo);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<PluginRepoRefreshOutcome | null>(null);
  // req 8 — a pinned repository has no refresh action: it stays at its exact
  // revision until the declaration changes, so the button could only ever
  // report "already at". `self` has no tracked version to move at all (req 27),
  // which the mockup ratified before the tab was built.
  const canRefresh = !isSelf && !repo.pinned;
  const runRefresh = async () => {
    setRefreshing(true);
    setRefreshed(null);
    try {
      setRefreshed(await refreshRepo(repo.name));
    } finally {
      setRefreshing(false);
    }
  };
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
        {/* req 12, mockup-plugins-tab.html §1 — the header's one action, right
            of everything that identifies the version it would move. Disabled
            while a round this session already started is running: refresh IS
            that round (`plugin-refresh.ts`), and a second one would queue
            behind the first and report on it. */}
        {canRefresh && (
          <CardAction
            className="ml-auto"
            disabled={refreshing || repo.status === "activating"}
            title={
              repo.status === "activating"
                ? "This repository is already updating"
                : `Fetch ${repo.name} at its declared ref and activate it now`
            }
            onClick={() => void runRefresh()}
          >
            {refreshing || repo.status === "activating" ? (
              <Spinner size={ICON_SIZE.XS} className="mr-1 inline" />
            ) : (
              <ArrowsClockwiseIcon size={ICON_SIZE.XS} className="mr-1 inline" />
            )}
            Refresh
          </CardAction>
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
          <AddKeyAction consumerRepoUrl={consumerRepoUrl} />
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
          reach={need.reach}
          optional={false}
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

      {/* reqs 23, 24 — the optional half of both lists, below every real need.
          "`assetgen` can use `pixellab.ai`" has to read differently from
          "`assetgen` needs `fal.run`": one is an offer, the other a gap. Same
          rows, same actions, quieter voice — the user who wants to close it
          still can, and the user who never will is not told off for it. */}
      {optionalKeys.map((need) => (
        <div
          key={`${need.alias}:${need.name}`}
          className="flex flex-wrap items-center gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm text-(--color-text-secondary)"
          data-testid={`plugin-credential-optional-${need.alias}-${need.name}`}
        >
          <KeyIcon size={ICON_SIZE.SM} className="flex-none text-(--color-text-tertiary)" />
          <span className="min-w-0 break-words">
            <span className="font-medium">{need.alias}</span> can use{" "}
            <code className="font-mono text-xs">{need.name}</code> — optional, and not set for this
            project
          </span>
          <AddKeyAction consumerRepoUrl={consumerRepoUrl} />
        </div>
      ))}

      {optionalHosts.map((need) => (
        <HostNeedRow
          key={`${need.alias}:${need.host}`}
          alias={need.alias}
          host={need.host}
          reach={need.reach}
          optional
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

      {refreshed && (
        <RefreshOutcomeRow outcome={refreshed} onDismiss={() => setRefreshed(null)} />
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
      {repo.pinned && (
        // req 8 — the answer to "why has this card no Refresh?", said on the
        // card rather than left as a difference between two cards for the user
        // to work out. It names the one thing that DOES move a pinned version.
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          {/* Names the ONE edit that moves it, not "shipit.yaml changes":
              editing a service, a setting or another plugin in the same file
              leaves this repository exactly where it is (review finding). */}
          Pinned to an exact revision — it moves only when this repository's{" "}
          <code className="font-mono">pin:</code> in{" "}
          <code className="font-mono">shipit.yaml</code> changes, so there is nothing to refresh.
        </div>
      )}
    </div>
  );
}

/**
 * plan §3's store trap, in one place because both credential rows need it:
 * "Add key…" opens the CONSUMING project's secret store, never the plugin
 * repository's — `setProjectSettingsRepoUrl` selects the store `/api/secrets`
 * writes to, so the plugin's URL would save the key where nothing reads it.
 * Absent when the session has no repository to save into.
 */
function AddKeyAction({ consumerRepoUrl }: { consumerRepoUrl: string | null }) {
  if (!consumerRepoUrl) return null;
  return (
    <CardAction
      className="ml-auto"
      onClick={() => useUiStore.getState().setProjectSettingsRepoUrl(consumerRepoUrl, "secrets")}
    >
      Add key…
    </CardAction>
  );
}

/**
 * req 12 — what the Refresh press did, said where it was pressed.
 *
 * It exists because THREE of the four outcomes are invisible in the card the
 * refetch brings back. `unchanged` is the plain case: the branch tip is what is
 * already live, so a correct refresh leaves the card byte-identical and the
 * button reads as broken. A re-install lands on the same commit for the same
 * reason (docs/266 reqs 5, 6). Even `activated` only moves nine characters of a
 * commit chip, which is not an answer to "did that work?".
 *
 * The failure half is deliberately still reported here even though the card
 * grows an issue row for it: the row is about the repository's state, this is
 * about the act, and a user who pressed a button is owed the answer next to it.
 * `RichErrorText` with `links={false}` because a detail carries git's output
 * and a plugin's own install stderr — the same reason the issue rows do.
 */
function RefreshOutcomeRow({
  outcome,
  onDismiss,
}: {
  outcome: PluginRepoRefreshOutcome;
  onDismiss: () => void;
}) {
  const short = outcome.commit ? outcome.commit.slice(0, 9) : null;
  const headline = outcome.kind === "failed"
    ? `Refresh failed${short ? ` — still on \`${short}\`` : ""}.`
    : outcome.kind === "activated"
      ? `Updated to \`${short ?? "a new commit"}\`.`
      : outcome.kind === "reinstalled"
        // Neither "updated" nor "already at": the commit did not move and the
        // plugin was installed again anyway (docs/273).
        ? `Re-installed \`${short ?? "the live commit"}\`.`
        : `Already at \`${short ?? "the declared version"}\` — nothing to update.`;
  return (
    <div
      className="flex flex-wrap items-start gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
      data-testid="plugin-refresh-outcome"
    >
      <span className="mt-0.5 flex-none">
        {outcome.kind === "failed" ? (
          <WarningIcon size={ICON_SIZE.SM} className="text-(--color-error)" />
        ) : outcome.kind === "unchanged" ? (
          <CheckCircleIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary)" />
        ) : (
          <CheckCircleIcon size={ICON_SIZE.SM} className="text-(--color-success)" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5 break-words">
        <p className="text-(--color-text-primary)">
          <RichErrorText text={headline} links={false} />
        </p>
        {outcome.detail && (
          <p className="text-xs text-(--color-text-secondary)">
            <RichErrorText text={outcome.detail} links={false} />
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-auto flex-none text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
      >
        <XIcon size={ICON_SIZE.SM} />
      </button>
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
 *
 * `optional` (reqs 23, 24) changes the sentence and the tone, and nothing else:
 * a host the plugin can use rather than needs is still named, still carries its
 * true `reach`, and still offers the grant — because the user may want it after
 * all, and the requirement's affordance is not theirs to lose for having
 * declared the host honestly. Where no grant would work (planning#383) the row
 * says why instead of offering a button, exactly as the required rows do; that
 * reason is stated per row here rather than collapsed into one, because an
 * optional row is already the quiet case and there is at most a handful.
 */
function HostNeedRow({
  alias,
  host,
  reach,
  optional,
  onGranted,
  onFailed,
}: {
  alias: string;
  host: string;
  reach: EgressHostReach;
  optional: boolean;
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

  const blocked = egressBlockedReason(reach);
  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm${
        optional ? " text-(--color-text-secondary)" : ""
      }`}
      data-testid={`plugin-host-${optional ? "optional" : "need"}-${alias}-${host}`}
    >
      <GlobeIcon
        size={ICON_SIZE.SM}
        className={`flex-none ${optional ? "text-(--color-text-tertiary)" : "text-(--color-warning)"}`}
      />
      <div className="min-w-0 flex-1 space-y-0.5 break-words">
        {optional ? (
          // The second clause is worded from the VERDICT, not from one sentence
          // that happens to be true of the grantable case. `blocked-by-deployment`
          // is decided before the allowlist is consulted at all
          // (`egress-host-reach.ts`), so an already-allowlisted host can carry
          // it — and "not in this session's egress allowlist" would then be a
          // plain falsehood, in the row whose whole job is to be quietly
          // accurate. `blocked.headline` below says which limit it is.
          <p>
            <span className="font-medium">{alias}</span> can use{" "}
            <code className="font-mono text-xs">{host}</code> — optional, and{" "}
            {blocked ? "not reachable from this session" : "not in this session's egress allowlist"}
          </p>
        ) : (
          <p>
            <code className="font-mono text-xs">{host}</code> is not in this session's egress
            allowlist — <span className="font-medium">{alias}</span> declares it
          </p>
        )}
        {/* planning#383 — where no grant can reach the host, say so instead of
            offering a button that writes an inert entry. */}
        {blocked && <p className="text-xs text-(--color-text-tertiary)">{blocked.headline}</p>}
      </div>
      {!blocked && (
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
      )}
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
              <Spinner size={ICON_SIZE.XS} className="mr-1 inline" />
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
