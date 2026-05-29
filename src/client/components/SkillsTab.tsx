/**
 * Settings → Skills tab (docs/149 — skill install UX).
 *
 * Two sub-tabs in v1: Discover (browse the active agent's catalog) and
 * Installed (list ShipIt-managed installs in the current session). v2 adds
 * Marketplaces + Errors.
 *
 * The tab is session-aware: the active session decides the catalog filter,
 * the install destination, and the install-button gate. Switching sessions
 * re-binds and re-fetches via the `sessionId` dep on the effects. v1 supports
 * Claude only — the tab disables with an explanatory empty state on Codex
 * (v1b will lift this; see plan).
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: per-session catalog/installed fetches + cross-tab refetch
import { useEffect, useMemo, useState } from "react";
import { useSkillsStore } from "../stores/skills-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Button } from "./ui/button.js";
import { SkillInstallSheet } from "./SkillInstallSheet.js";
import type { PluginInfo } from "../../server/shared/types.js";

type SubTab = "discover" | "installed";

export function SkillsTab({ hasActiveSession }: { hasActiveSession: boolean }) {
  const [subTab, setSubTab] = useState<SubTab>("discover");
  const [installingSheet, setInstallingSheet] = useState<PluginInfo | null>(null);
  const [search, setSearch] = useState("");

  const sessionId = useSessionStore((s) => s.sessionId);
  const agentId = useUiStore((s) => s.activeAgentId);

  const marketplaces = useSkillsStore((s) => s.marketplaces);
  const pluginsByMarketplace = useSkillsStore((s) => s.pluginsByMarketplace);
  const installed = useSkillsStore((s) => s.installed);
  const loading = useSkillsStore((s) => s.loading);
  const error = useSkillsStore((s) => s.error);

  const fetchMarketplaces = useSkillsStore((s) => s.fetchMarketplaces);
  const fetchPlugins = useSkillsStore((s) => s.fetchPlugins);
  const refreshMarketplace = useSkillsStore((s) => s.refreshMarketplace);
  const fetchInstalled = useSkillsStore((s) => s.fetchInstalled);
  const install = useSkillsStore((s) => s.install);
  const uninstall = useSkillsStore((s) => s.uninstall);

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

  // Per-session installed list. Refetch on session switch — the install
  // sheet's own success path also refetches via the store action.
  // eslint-disable-next-line no-restricted-syntax -- effect rebinding to per-session HTTP source on switch
  useEffect(() => {
    if (!sessionId) return;
    void fetchInstalled(sessionId);
  }, [sessionId, fetchInstalled]);

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
      {/* Sub-tab strip */}
      <div className="flex items-center gap-1 px-5 pt-3 pb-2 border-b border-(--color-border-secondary)">
        <SubTabButton
          label="Discover"
          active={subTab === "discover"}
          onClick={() => setSubTab("discover")}
        />
        <SubTabButton
          label="Installed"
          active={subTab === "installed"}
          count={installed.length || undefined}
          onClick={() => setSubTab("installed")}
        />
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
        {subTab === "discover" && (
          <DiscoverList
            plugins={filteredPlugins}
            loading={loading}
            error={error}
            search={search}
            onSearchChange={setSearch}
            marketplaces={marketplaces}
            onRefreshMarketplace={(id) => void refreshMarketplace(id)}
            onInstallClick={(plugin) => setInstallingSheet(plugin)}
            hasActiveSession={hasActiveSession}
          />
        )}

        {subTab === "installed" && (
          <InstalledList
            installed={installed}
            onUninstall={async (marketplaceId, pluginName) => {
              if (!sessionId) return;
              try {
                await uninstall(sessionId, marketplaceId, pluginName);
              } catch {
                // Error is already surfaced via the store; nothing to do.
              }
            }}
            hasActiveSession={hasActiveSession}
          />
        )}
      </div>

      {installingSheet && (
        <SkillInstallSheet
          plugin={installingSheet}
          installPathLabel=".claude/skills"
          agentRunning={false}
          installing={loading}
          hasActiveSession={Boolean(hasActiveSession && sessionId)}
          onCancel={() => setInstallingSheet(null)}
          fetchSkillBody={fetchSkillBody}
          onInstall={async () => {
            if (!sessionId) return;
            try {
              await install(sessionId, installingSheet.marketplaceId, installingSheet.name);
              setInstallingSheet(null);
              useUiStore.getState().setToast({
                message: `Installed ${installingSheet.name}. New skills are available for your next message.`,
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

function SubTabButton({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
        active
          ? "bg-(--color-bg-hover) text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
      }`}
      data-testid={`skills-subtab-${label.toLowerCase()}`}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1.5 text-(--color-text-tertiary)">{count}</span>
      )}
    </button>
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
  hasActiveSession,
}: {
  plugins: PluginInfo[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (s: string) => void;
  marketplaces: { id: string; status: string; fetchError?: string }[];
  onRefreshMarketplace: (id: string) => void;
  onInstallClick: (plugin: PluginInfo) => void;
  hasActiveSession: boolean;
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

      {!hasActiveSession && (
        <div className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs text-(--color-text-secondary)">
          Open or create a session to install skills.
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

function InstalledList({
  installed,
  onUninstall,
  hasActiveSession,
}: {
  installed: { marketplaceId: string; pluginName: string; skillName: string }[];
  onUninstall: (marketplaceId: string, pluginName: string) => Promise<void>;
  hasActiveSession: boolean;
}) {
  if (!hasActiveSession) {
    return (
      <div className="text-xs text-(--color-text-tertiary) py-6 text-center">
        Open a session to see installed skills.
      </div>
    );
  }

  // Group by plugin so we render one row per plugin (a plugin may install
  // multiple skills under `<plugin>__<skill>/` directories).
  const grouped = new Map<string, { marketplaceId: string; pluginName: string; skills: string[] }>();
  for (const e of installed) {
    const key = `${e.marketplaceId}/${e.pluginName}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.skills.push(e.skillName);
    } else {
      grouped.set(key, {
        marketplaceId: e.marketplaceId,
        pluginName: e.pluginName,
        skills: [e.skillName],
      });
    }
  }

  if (grouped.size === 0) {
    return (
      <div className="text-xs text-(--color-text-tertiary) py-6 text-center">
        No plugins installed yet. Browse Discover to add one.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="skills-installed-list">
      {Array.from(grouped.values()).map((g) => (
        <li
          key={`${g.marketplaceId}/${g.pluginName}`}
          className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex items-start gap-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-(--color-text-primary) truncate">
                {g.pluginName}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-(--color-text-tertiary) shrink-0">
                {g.marketplaceId}
              </span>
            </div>
            <div className="text-[11px] text-(--color-text-tertiary) mt-0.5">
              {g.skills.length} skill{g.skills.length === 1 ? "" : "s"}:{" "}
              {g.skills.map((s) => `/${g.pluginName}:${s}`).join(", ")}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onUninstall(g.marketplaceId, g.pluginName)}
            className="rounded-md shrink-0 text-(--color-error) hover:text-(--color-error)"
            data-testid={`skills-uninstall-${g.pluginName}`}
          >
            Uninstall
          </Button>
        </li>
      ))}
    </ul>
  );
}
