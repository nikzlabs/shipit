// eslint-disable-next-line no-restricted-imports -- useEffect needed to load tracker status on mount (external state sync)
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button.js";
import { ManagedByShipItBadge } from "./ManagedByShipItBadge.js";
import { useIssuesStore } from "../stores/issues-store.js";

interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/**
 * Linear **credential** settings (docs/170, reworked by docs/248 req 4).
 *
 * This surface holds the API token and nothing that identifies a destination.
 * Which Linear team a repository's Issues tab shows is part of that repository's
 * declaration:
 *
 * ```yaml
 * issues:
 *   trackers:
 *     - kind: linear
 *       team: SHI
 *       name: roadmap
 * ```
 *
 * so the team picker that used to persist a deployment-wide binding is gone. The
 * team list is still fetched, but as a **lookup**: it answers "which team keys
 * can this credential reach?", which is a property of the *credential* and so
 * belongs here. Nothing here writes to anyone's `shipit.yaml` — deployments that
 * had a stored team simply lose their Linear tab until a repository declares one,
 * which is the clean break the requirements chose over a migration.
 *
 * **This card is workspace-scoped and shows nothing repository-scoped.** It
 * briefly carried a `shipit.yaml` declaration snippet to explain how a repository
 * gets its Issues tab; that is per-repository configuration and does not belong
 * in the workspace-wide Settings dialog, so it is gone. A repository's declared
 * trackers already surface where they are actionable — as the Issues tab's
 * sub-tabs — and repo-scoped settings live in the Project Settings dialog.
 *
 * Connection state is derived from the teams lookup rather than from the tracker
 * list, because after docs/248 a connected credential with no declaration
 * produces no Linear tracker at all — the absence of a tab is not the absence of
 * a credential.
 */
export function SettingsTrackers({ embedded = false, logo }: { embedded?: boolean; logo?: ReactNode } = {}) {
  const [token, setToken] = useState("");
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = async () => {
    try {
      const res = await fetch("/api/trackers/linear/teams", { headers: { Accept: "application/json" } });
      if (!res.ok) {
        // 400 "Connect Linear first" is the no-credential case, not an error to show.
        setConnected(false);
        setTeams(null);
        return;
      }
      const data = (await res.json()) as { teams?: LinearTeam[] };
      setConnected(true);
      setTeams(data.teams ?? []);
    } catch {
      /* ignore — the card falls back to the connect form */
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- one-shot load of credential status when the tab opens
  useEffect(() => {
    void loadTeams();
  }, []);

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
      setConnected(true);
      setToken("");
      // A repository that already declares a `kind: linear` tracker becomes
      // reachable the moment the credential lands, so refresh the sub-tabs.
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
      setConnected(false);
      setTeams(null);
      void useIssuesStore.getState().fetchTrackers();
    } finally {
      setBusy(false);
    }
  };

  // Disconnect is an integration-level action, so it sits in the card header
  // (top-right) — the same place GitHub's Disconnect lives.
  const headerActions = connected ? (
    <div className="ml-auto shrink-0">
      <Button variant="ghost" size="md" disabled={busy} onClick={handleDisconnect} data-testid="trackers-disconnect">
        Disconnect
      </Button>
    </div>
  ) : null;

  const detail = connected ? (
    <div className="space-y-3" data-testid="linear-connected">
      <div className="flex items-center gap-3">
        <span className="w-2.5 h-2.5 rounded-full bg-(--color-success) shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-(--color-text-primary)">Linear</p>
          <p className="text-xs text-(--color-text-secondary)">Credential connected</p>
        </div>
      </div>
      <div className="space-y-2">
        {teams && teams.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-(--color-text-tertiary)">Teams this token can reach:</p>
            <div className="flex flex-wrap gap-1">
              {teams.map((team) => (
                <span
                  key={team.id}
                  title={team.name}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-(--color-border-secondary) bg-(--color-bg-elevated) text-xs"
                >
                  <span className="font-mono text-(--color-text-primary)">{team.key}</span>
                  <span className="text-(--color-text-tertiary) truncate max-w-40">{team.name}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {teams?.length === 0 && (
          <p className="text-xs text-(--color-text-tertiary)">No teams found for this token.</p>
        )}
      </div>
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
            Connect a Linear API key so repositories that declare a Linear tracker can show their
            issues in the Issues tab. The credential lives here; which team it reads lives in each
            repository&apos;s <code>shipit.yaml</code>.
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
