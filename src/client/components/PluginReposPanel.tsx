import { WarningIcon, PlugsIcon, KeyIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
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
        {/* req 23 — an unset credential is a need, not a failure: the version
            is live and whole, one key away from working. */}
        {missingKeys.length > 0 && (
          <Chip tone="warn">{`${missingKeys.length} need${missingKeys.length > 1 ? "s" : ""}`}</Chip>
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
            <button
              type="button"
              onClick={() =>
                useUiStore.getState().setProjectSettingsRepoUrl(consumerRepoUrl, "secrets")
              }
              className="ml-auto rounded-md border border-(--color-border-primary) px-2 py-1 text-xs hover:bg-(--color-bg-hover)"
            >
              Add key…
            </button>
          )}
        </div>
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
              understands it. `RichErrorText` is the existing one. */}
          <span className="min-w-0 break-words"><RichErrorText text={issue} /></span>
        </div>
      ))}

      {!isSelf && repo.status === "active" && (
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          {/* This sentence used to end "…land with the remaining plugin
              mechanics (docs/262)" — the honest placeholder of tab v0, left
              behind once those mechanics shipped, so an ACTIVE card told the
              user its commands, skills and services did not exist yet (found in
              the dogfood). What it says now is req 15's coherence guarantee,
              which is the fact this row exists to state. */}
          Checked out at this exact commit — the files, companion CLIs, skills and services this
          session gets from this repository all come from it.
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
