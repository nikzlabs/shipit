import { useState } from "react";
import { WarningIcon, PlugsIcon, KeyIcon, GlobeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePluginReposStore, type PluginHostGrantScope } from "../stores/plugin-repos-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { PluginRepoCardView } from "../../server/shared/plugin-repos.js";
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
  // req 24 — the same two lists for declared external hosts. A host the session
  // may not reach is a gap the user closes deliberately; a host it may reach is
  // stated quietly, because the requirement asks the session to SHOW what a
  // plugin needs, not only what is broken.
  const blockedHosts = repo.uses.flatMap((u) =>
    (u.hosts ?? []).filter((h) => !h.allowed).map((h) => ({ alias: u.alias, host: h.host })),
  );
  const allowedHosts = repo.uses.flatMap((u) =>
    (u.hosts ?? []).filter((h) => h.allowed).map((h) => ({ alias: u.alias, host: h.host })),
  );
  const needCount = missingKeys.length + blockedHosts.length;
  return (
    <div className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-secondary) overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border-primary) px-3 py-2 text-sm">
        <span className="font-semibold">{repo.name}</span>
        {/* req 19 — the repo identity stays visible in every card state. */}
        <Chip mono>{isSelf ? "self · live working tree" : repo.source}</Chip>
        {!isSelf && (
          <Chip mono>{`${repo.ref ?? "default branch"} @ ${repo.commit ? repo.commit.slice(0, 9) : "—"}`}</Chip>
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
      {blockedHosts.map((need) => (
        <HostNeedRow key={`${need.alias}:${need.host}`} alias={need.alias} host={need.host} />
      ))}

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
 */
function HostNeedRow({ alias, host }: { alias: string; host: string }) {
  const allowHost = usePluginReposStore((s) => s.allowHost);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grant = async (scope: PluginHostGrantScope) => {
    setBusy(true);
    setError(null);
    try {
      await allowHost(host, scope);
    } catch {
      // The snapshot was refetched regardless (the store's `finally`), so the
      // row disappears if the host landed anyway — this only speaks for the
      // case where it did not.
      setError("Could not add it to the allowlist. Try again, or add it in Settings → Network egress.");
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
        <CardAction
          disabled={busy}
          title="Add it to this session's allowlist. Applies immediately."
          onClick={() => void grant("session")}
        >
          Allow for session
        </CardAction>
        <CardAction
          disabled={busy}
          title="Add it to the instance-wide allowlist, for this and future sessions. A running service may need a restart to pick it up."
          onClick={() => void grant("global")}
        >
          Allow for ShipIt
        </CardAction>
      </span>
      {error && <span className="w-full text-xs text-(--color-error)">{error}</span>}
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
