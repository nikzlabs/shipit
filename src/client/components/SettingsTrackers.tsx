// eslint-disable-next-line no-restricted-imports -- useEffect needed to load tracker status on mount (external state sync)
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button.js";
import { ManagedByShipItBadge } from "./ManagedByShipItBadge.js";
import { useIssuesStore } from "../stores/issues-store.js";
import type { TrackerInfo } from "../../server/shared/types.js";

interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/**
 * Linear connection settings (docs/170). A Linear workspace is deployment-wide,
 * so the binding lives here in settings rather than as a per-repo fact. v1 is
 * the simplest read-only path: paste a Linear API token, pick a team. No OAuth
 * app registration / webhooks (that's the docs/156 push trigger, not this read
 * surface). The token is write-only — the server never echoes it back.
 */
export function SettingsTrackers({ embedded = false, logo }: { embedded?: boolean; logo?: ReactNode } = {}) {
  const [info, setInfo] = useState<TrackerInfo | null>(null);
  const [token, setToken] = useState("");
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changingTeam, setChangingTeam] = useState(false);

  const loadInfo = async () => {
    try {
      const res = await fetch("/api/trackers", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { trackers?: TrackerInfo[] };
      setInfo(data.trackers?.find((t) => t.id === "linear") ?? null);
    } catch {
      /* ignore */
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- one-shot load of tracker status when the tab opens
  useEffect(() => {
    void loadInfo();
  }, []);

  const tokenConfigured = Boolean(info?.configured) || teams.length > 0;

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trackers/linear/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; teams?: LinearTeam[] };
      if (!res.ok) {
        setError(data.error ?? "Failed to connect Linear");
        return;
      }
      setTeams(data.teams ?? []);
      setToken("");
      await loadInfo();
    } finally {
      setBusy(false);
    }
  };

  const handleChangeTeam = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trackers/linear/teams", { headers: { Accept: "application/json" } });
      const data = (await res.json().catch(() => ({}))) as { error?: string; teams?: LinearTeam[] };
      if (!res.ok) {
        setError(data.error ?? "Failed to list teams");
        return;
      }
      setTeams(data.teams ?? []);
      setChangingTeam(true);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectTeam = async (team: LinearTeam) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trackers/linear/team", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(team),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; tracker?: TrackerInfo };
      if (!res.ok) {
        setError(data.error ?? "Failed to bind team");
        return;
      }
      setInfo(data.tracker ?? null);
      setTeams([]);
      setChangingTeam(false);
      // Refresh the Issues tab's sub-tab metadata + list.
      void useIssuesStore.getState().fetchTrackers();
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/trackers/linear/disconnect", { method: "POST", headers: { Accept: "application/json" } });
      setTeams([]);
      setChangingTeam(false);
      await loadInfo();
      void useIssuesStore.getState().fetchTrackers();
    } finally {
      setBusy(false);
    }
  };

  const connected = Boolean(info?.configured) && !changingTeam;

  // Disconnect is an integration-level action, so it sits in the card header
  // (top-right) — the same place GitHub's Disconnect lives. "Change team" is
  // team-scoped, so it lives on the team's own line in the detail below, not
  // up here far from the team it acts on.
  const headerActions = connected ? (
    <div className="ml-auto shrink-0">
      <Button variant="ghost" size="md" disabled={busy} onClick={handleDisconnect} data-testid="trackers-disconnect">
        Disconnect
      </Button>
    </div>
  ) : null;

  // The integration's own state/settings, rendered inside the same card below a
  // divider — not as a separate floating card.
  const detail = connected ? (
    <div className="flex items-center gap-3">
      <span className="w-2.5 h-2.5 rounded-full bg-(--color-success) shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-(--color-text-primary)">
          {info?.binding?.name ?? "Linear"}
          {info?.binding && (
            <span className="ml-1 text-(--color-text-tertiary) font-mono text-xs">{info.binding.key}</span>
          )}
        </p>
        <p className="text-xs text-(--color-text-secondary)">Connected</p>
      </div>
      <Button variant="secondary" size="md" disabled={busy} onClick={handleChangeTeam} className="ml-auto shrink-0">
        Change team
      </Button>
    </div>
  ) : tokenConfigured || changingTeam ? (
    <div className="space-y-3">
      <p className="text-xs text-(--color-text-secondary)">Pick the team whose issues you want to see:</p>
      {teams.length === 0 ? (
        <p className="text-xs text-(--color-text-tertiary)">No teams found for this token.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {teams.map((team) => (
            <button
              key={team.id}
              disabled={busy}
              onClick={() => void handleSelectTeam(team)}
              className="flex items-center gap-2 px-3 py-2 text-left text-sm rounded-md border border-(--color-border-secondary) bg-(--color-bg-elevated) hover:bg-(--color-bg-hover) text-(--color-text-primary) disabled:opacity-50"
            >
              <span className="font-mono text-xs text-(--color-text-tertiary)">{team.key}</span>
              <span className="truncate">{team.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  ) : (
    <div className="space-y-3">
      <label className="block text-xs text-(--color-text-secondary)" htmlFor="linear-token">
        Linear API token
      </label>
      <input
        id="linear-token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="lin_api_..."
        data-testid="linear-token-input"
        className="w-full bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:ring-1 focus:ring-(--color-border-focus)"
      />
      <p className="text-xs text-(--color-text-tertiary)">
        Create a personal API key in Linear → Settings → Security &amp; access → Personal API keys.
        Stored server-side and never shown again.
      </p>
      <Button variant="primary" size="md" disabled={busy || !token.trim()} onClick={handleConnect}>
        {busy ? "Connecting…" : "Connect Linear"}
      </Button>
    </div>
  );

  const card = (
    <div
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)"
      data-testid="settings-trackers"
    >
      <div className="flex items-start gap-3 p-3">
        {logo}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-(--color-text-primary)">Linear</h3>
            <ManagedByShipItBadge />
          </div>
          <p className="text-xs text-(--color-text-secondary) mt-1">
            Connect Linear to see your prioritized issues in the Issues tab and start a session from
            any of them. Read-only: ShipIt never changes your issues.
          </p>
        </div>
        {headerActions}
      </div>
      <div className="h-px bg-(--color-border-secondary)" />
      <div className="p-3 space-y-3">
        {error && (
          <div className="p-2 rounded bg-(--color-error-subtle) text-(--color-error) text-xs">{error}</div>
        )}
        {detail}
      </div>
    </div>
  );

  return embedded ? card : (
    <div className="px-5 py-4 overflow-y-auto h-full">{card}</div>
  );
}
