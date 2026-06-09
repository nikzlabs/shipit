/**
 * Settings → Skills tab (docs/149 — skill install UX, 2026-06-09 v1c revision).
 *
 * Discover-only: browse the agent's catalog and install. Install is **app-wide
 * and repo-targeted**, NOT session-bound — the user picks a destination
 * repository in the install sheet and the install runs in its own dedicated
 * session that opens a PR (`POST /api/plugins/install`). The session the user is
 * currently in is never touched.
 *
 * There is no Installed list or uninstall button: removing a marketplace skill
 * is a plain "delete the dir + commit" the user asks the agent to do
 * (CLAUDE.md §5 — chat is the input surface, the agent is the actor). Install
 * keeps its UI because it adds value the agent can't replicate cheaply: catalog
 * discovery, preview-before-consent, and the namespaced flat-dir write.
 *
 * v1 supports Claude only — the tab shows a "v1b" empty state on Codex.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: catalog fetches as the agent/marketplaces change
import { useEffect, useMemo, useState } from "react";
import { useSkillsStore } from "../stores/skills-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import { Button } from "./ui/button.js";
import { SkillInstallSheet, type InstallRepoOption } from "./SkillInstallSheet.js";
import type { PluginInfo } from "../../server/shared/types.js";

export function SkillsTab() {
  const [installingSheet, setInstallingSheet] = useState<PluginInfo | null>(null);
  const [search, setSearch] = useState("");

  const agentId = useUiStore((s) => s.activeAgentId);

  // Install destination is repo-targeted (docs/149 v1c) — the Skills tab is
  // app-wide and never reads/mutates the active session. Repos come from the
  // app-wide repo store; default the picker to the active repo.
  const repos = useRepoStore((s) => s.repos);
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | null>(null);

  const repoOptions: InstallRepoOption[] = useMemo(
    () => repos.map((r) => ({ url: r.url, label: parseRepoLabel(r.url), ready: r.status === "ready" })),
    [repos],
  );
  const effectiveRepoUrl =
    selectedRepoUrl ??
    (activeRepoUrl && repos.some((r) => r.url === activeRepoUrl) ? activeRepoUrl : repos[0]?.url ?? null);

  const marketplaces = useSkillsStore((s) => s.marketplaces);
  const pluginsByMarketplace = useSkillsStore((s) => s.pluginsByMarketplace);
  const loading = useSkillsStore((s) => s.loading);
  const error = useSkillsStore((s) => s.error);

  const fetchMarketplaces = useSkillsStore((s) => s.fetchMarketplaces);
  const fetchPlugins = useSkillsStore((s) => s.fetchPlugins);
  const refreshMarketplace = useSkillsStore((s) => s.refreshMarketplace);
  const installToRepo = useSkillsStore((s) => s.installToRepo);

  // Refetch catalogs whenever the active agent changes — store sync from
  // the route-backed external system.
  // eslint-disable-next-line no-restricted-syntax -- effect for one-shot fetch when the active agent flips
  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 7: marketplace install is Claude-only in v1; becomes a capability flag once Codex install (v1b) lands.
    if (agentId !== "claude") return;
    void fetchMarketplaces(agentId);
  }, [agentId, fetchMarketplaces]);

  // After we know the catalogs, pull each one's plugin list. v1 ships with
  // exactly one seeded catalog so this is fine inline; v2 paginates / lazy-
  // loads as the user expands per-marketplace sections.
  // eslint-disable-next-line no-restricted-syntax -- effect to fan out per-marketplace fetches as the list arrives
  useEffect(() => {
    if (marketplaces.length === 0) return;
    for (const m of marketplaces) {
      if (!pluginsByMarketplace[m.id]) void fetchPlugins(m.id);
    }
  }, [marketplaces, pluginsByMarketplace, fetchPlugins]);

  const allPlugins = useMemo(() => {
    const out: PluginInfo[] = [];
    for (const m of marketplaces) {
      const ps = pluginsByMarketplace[m.id];
      if (ps) out.push(...ps);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [marketplaces, pluginsByMarketplace]);

  const filteredPlugins = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allPlugins;
    return allPlugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false),
    );
  }, [allPlugins, search]);

  const fetchSkillBody = async (pluginName: string, skillName: string): Promise<string> => {
    const plugin = allPlugins.find((p) => p.name === pluginName);
    if (!plugin) throw new Error("Unknown plugin");
    const res = await fetch(
      `/api/marketplaces/${encodeURIComponent(plugin.marketplaceId)}/plugins/${encodeURIComponent(pluginName)}/skills/${encodeURIComponent(skillName)}`,
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { content: string };
    return data.content;
  };

  // Codex is v1b — show a friendly empty state on the tab rather than half-rendering.
  // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 7: marketplace install is Claude-only in v1; becomes a capability flag once Codex install (v1b) lands.
  if (agentId !== "claude") {
    return (
      <div className="px-5 py-4 text-sm text-(--color-text-secondary)">
        <h3 className="text-sm font-medium text-(--color-text-primary) mb-2">Skills</h3>
        <p>
          Skill discovery and install is currently only available for Claude. Codex support is
          tracked in <code>docs/149</code> as v1b — it&apos;s pending the upstream catalog format
          spike before we can ship it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
        <DiscoverList
          plugins={filteredPlugins}
          loading={loading}
          error={error}
          search={search}
          onSearchChange={setSearch}
          marketplaces={marketplaces}
          onRefreshMarketplace={(id) => void refreshMarketplace(id)}
          onInstallClick={(plugin) => setInstallingSheet(plugin)}
        />
      </div>

      {installingSheet && (
        <SkillInstallSheet
          plugin={installingSheet}
          installPathLabel=".claude/skills"
          installing={loading}
          repos={repoOptions}
          selectedRepoUrl={effectiveRepoUrl}
          onSelectRepo={setSelectedRepoUrl}
          onCancel={() => setInstallingSheet(null)}
          fetchSkillBody={fetchSkillBody}
          onInstall={async () => {
            if (!effectiveRepoUrl) return;
            try {
              const result = await installToRepo(
                effectiveRepoUrl,
                installingSheet.marketplaceId,
                installingSheet.name,
              );
              setInstallingSheet(null);
              useUiStore.getState().setToast({
                message:
                  `Opened pull request #${result.pr.number} to install ${installingSheet.name}. ` +
                  `Review it in the new session, then merge to use the skill.`,
              });
            } catch (err) {
              useUiStore.getState().setToast({
                message: `Install failed: ${(err as Error).message}`,
              });
            }
          }}
        />
      )}
    </div>
  );
}

function DiscoverList({
  plugins,
  loading,
  error,
  search,
  onSearchChange,
  marketplaces,
  onRefreshMarketplace,
  onInstallClick,
}: {
  plugins: PluginInfo[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (s: string) => void;
  marketplaces: { id: string; status: string; fetchError?: string }[];
  onRefreshMarketplace: (id: string) => void;
  onInstallClick: (plugin: PluginInfo) => void;
}) {
  const failed = marketplaces.filter((m) => m.status === "fetch-failed");

  return (
    <div className="flex flex-col gap-3">
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search skills…"
        className="w-full rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-1.5 text-xs text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
        data-testid="skills-discover-search"
      />

      {/* Per-marketplace fetch-failed retry rows (v1's stand-in for v2's Errors tab). */}
      {failed.map((m) => (
        <div
          key={m.id}
          className="rounded-md border border-(--color-error)/40 bg-(--color-error-subtle) p-3 text-xs flex items-start justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="font-medium text-(--color-error)">{m.id}</div>
            <div className="text-(--color-text-secondary) mt-0.5 break-words">
              {m.fetchError ?? "Failed to fetch catalog"}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRefreshMarketplace(m.id)}
            className="rounded-md shrink-0"
          >
            Retry
          </Button>
        </div>
      ))}

      {error && !failed.length && (
        <div className="rounded-md border border-(--color-error)/40 bg-(--color-error-subtle) p-3 text-xs text-(--color-error)">
          {error}
        </div>
      )}

      {loading && plugins.length === 0 && (
        <div className="text-xs text-(--color-text-tertiary) py-6 text-center">Loading…</div>
      )}

      {!loading && plugins.length === 0 && marketplaces.length > 0 && !failed.length && (
        <div className="text-xs text-(--color-text-tertiary) py-6 text-center">
          No installable skills match your search.
        </div>
      )}

      <ul className="flex flex-col gap-2" data-testid="skills-discover-list">
        {plugins.map((p) => (
          <li
            key={`${p.marketplaceId}/${p.name}`}
            className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex items-start gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-(--color-text-primary) truncate">
                  {p.name}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-(--color-text-tertiary) shrink-0">
                  {p.marketplaceId}
                </span>
              </div>
              {p.description && (
                <p className="text-xs text-(--color-text-secondary) mt-0.5 line-clamp-2">
                  {p.description}
                </p>
              )}
              <div className="text-[11px] text-(--color-text-tertiary) mt-1">
                {p.skills.length} skill{p.skills.length === 1 ? "" : "s"}
                {p.author && ` · by ${p.author}`}
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onInstallClick(p)}
              className="rounded-md shrink-0"
              data-testid={`skills-install-${p.name}`}
            >
              Install
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
