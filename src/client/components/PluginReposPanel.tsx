import { WarningIcon, PlugsIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
import type { PluginRepoCardView } from "../../server/shared/plugin-repos.js";

/**
 * docs/262 — the Plugins tab pane (plan §3, mockup-plugins-tab.html): one card
 * per declared repo, with the full repo identity always visible (req 19).
 * v0 renders declarations, self-use, per-repo issues, and parse warnings; the
 * live states (active generation, refresh, needs, degraded/collision) arrive
 * with the slice-2 mechanics.
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
        <PluginRepoCard key={repo.name} repo={repo} />
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

function PluginRepoCard({ repo }: { repo: PluginRepoCardView }) {
  const isSelf = repo.status === "self";
  const statusLabel = STATUS_LABEL[repo.status];
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

      {repo.issues.map((issue, i) => (
        <div
          key={i}
          className="flex items-start gap-2 border-t border-(--color-border-primary) px-3 py-2 text-sm"
        >
          <WarningIcon size={ICON_SIZE.SM} className="mt-0.5 flex-none text-(--color-warning)" />
          <span className="min-w-0 break-words">{issue}</span>
        </div>
      ))}

      {!isSelf && repo.status === "active" && (
        <div className="border-t border-(--color-border-primary) px-3 py-2 text-xs text-(--color-text-tertiary)">
          Checked out at this exact commit. Commands, skills, and services from this repository
          land with the remaining plugin mechanics (docs/262).
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
          This repository's own exports, live from the working tree — edits apply without a
          refresh (activation mechanics under development, docs/262).
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
