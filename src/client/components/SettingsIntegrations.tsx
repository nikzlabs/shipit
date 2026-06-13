import { useState, type ReactNode } from "react";
import { GithubLogoIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { StatusDot } from "./ui/status-dot.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { SettingsTrackers } from "./SettingsTrackers.js";
import { McpServerSettings } from "./McpServerSettings.js";
import { ManagedByShipItBadge } from "./ManagedByShipItBadge.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * Settings → Integrations (docs/201).
 *
 * One tab for everything the user connects to ShipIt, tiered into two
 * sections so the mechanisms don't read as interchangeable:
 *
 *  1. **Connected services** — curated first-party integrations (GitHub,
 *     Linear). Credentials are brokered by ShipIt and never enter the session
 *     container; their data renders inline in chat. Badged "Managed by ShipIt".
 *  2. **MCP servers** — user-supplied tool extensions via the Model Context
 *     Protocol. These run with whatever credentials the user provides.
 *
 * The split closes the discoverability gap that sent users hunting for a
 * Linear MCP (which would bypass the `shipit issue` brokering): Linear now
 * lives right next to GitHub, visibly *not* an MCP. See docs/190 for the
 * removal of the duplicate Linear MCP OAuth preset this builds on.
 */

interface SettingsIntegrationsProps {
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubLogout: () => void;
  onGitHubTokenSubmit: (token: string) => Promise<void> | void;
  hasActiveSession: boolean;
}

/** 36px rounded tile that frames a service's brand mark. */
function LogoTile({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) text-(--color-text-primary)">
      {children}
    </div>
  );
}

/** Linear brand mark. Phosphor has no Linear logo; a brand glyph is the
 * sanctioned exception to the "no hardcoded SVG" rule (it's a logo, not a
 * generic UI icon). */
function LinearLogo() {
  return (
    <svg viewBox="0 0 100 100" width={ICON_SIZE.MD} height={ICON_SIZE.MD} fill="#5e6ad2" aria-hidden="true">
      <path d="M1.2 61.3c-.2-.8.8-1.4 1.4-.8l36 36c.6.6 0 1.6-.8 1.4A50.2 50.2 0 0 1 1.2 61.3Zm-1.1-15c0-.5.6-.8 1-.4l52 52c.4.4.1 1-.4 1a50 50 0 0 1-9.5-2.3L2.4 55.8A50 50 0 0 1 .1 46.3Zm3.4-14.7c.2-.5.8-.6 1.2-.2l64 64c.4.4.3 1-.2 1.2a50.2 50.2 0 0 1-5.6 1.9L1.6 37.2a50 50 0 0 1 1.9-5.6ZM10 19.2 80.8 90C93 81 101 66.4 101 50 101 22.4 78.6 0 51 0 34.6 0 20 8 10 19.2Z" />
    </svg>
  );
}

/**
 * GitHub-specific PR-automation toggle. Lives under the GitHub row because it's
 * a GitHub-scoped behavior, not a generic setting. Optimistic with a revert +
 * toast on failure (moved here from Settings.tsx's GitHub tab, docs/201).
 */
function PullRequestSettings() {
  const autoCreatePr = useSettingsStore((s) => s.autoCreatePr);

  const handleToggle = async (v: boolean) => {
    useSettingsStore.getState().setAutoCreatePr(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoCreatePr: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setAutoCreatePr(!v);
      useUiStore.getState().setToast({ message: "Failed to update auto-create PR setting" });
      console.error("[settings] toggle autoCreatePr failed:", err);
    }
  };

  return (
    <div className="ml-12 flex items-center justify-between gap-4 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2">
      <div>
        <span className="text-sm text-(--color-text-primary)">Auto-create PR after every meaningful turn</span>
        <p className="text-xs text-(--color-text-tertiary)">
          When the agent finishes a turn that changes files, ShipIt opens a pull request automatically.
        </p>
      </div>
      <button
        onClick={() => void handleToggle(!autoCreatePr)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          autoCreatePr ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
        }`}
        role="switch"
        aria-checked={autoCreatePr}
        data-testid="settings-auto-create-pr"
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            autoCreatePr ? "translate-x-4.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/** GitHub connection row: a "Managed by ShipIt" connected card + nested PR
 * toggle when authenticated, the token form otherwise. */
function GitHubConnectionCard({
  githubStatus,
  onGitHubLogout,
  onGitHubTokenSubmit,
}: Pick<SettingsIntegrationsProps, "githubStatus" | "onGitHubLogout" | "onGitHubTokenSubmit">) {
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  if (!githubStatus.authenticated) {
    return (
      <GitHubTokenForm onSubmit={async (t) => { await onGitHubTokenSubmit(t); return undefined; }} />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3">
        <LogoTile>
          <GithubLogoIcon size={ICON_SIZE.MD} weight="fill" />
        </LogoTile>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium text-(--color-text-primary)">
              {githubStatus.username ?? "GitHub"}
            </p>
            <ManagedByShipItBadge />
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-(--color-text-secondary)">
            <StatusDot status="success" /> Connected
          </p>
        </div>
        <button
          onClick={() => {
            if (confirmingLogout) {
              setDisconnecting(true);
              onGitHubLogout();
              setConfirmingLogout(false);
            } else {
              setConfirmingLogout(true);
            }
          }}
          onBlur={() => { if (!disconnecting) setConfirmingLogout(false); }}
          disabled={disconnecting}
          className={`ml-auto rounded-md border px-3 py-1.5 text-sm transition-colors ${
            disconnecting
              ? "cursor-not-allowed border-(--color-border-secondary) bg-(--color-bg-secondary) text-(--color-text-tertiary) opacity-50"
              : confirmingLogout
                ? "border-(--color-error)/50 bg-(--color-error-subtle) text-(--color-error)"
                : "border-(--color-border-secondary) bg-(--color-bg-secondary) text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          }`}
          data-testid="settings-disconnect"
        >
          {disconnecting ? "Disconnecting..." : confirmingLogout ? "Click again to disconnect" : "Disconnect"}
        </button>
      </div>
      <PullRequestSettings />
    </div>
  );
}

function SectionHeader({ title, hint, description }: { title: string; hint: string; description: string }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-(--color-text-primary)">{title}</h3>
        <span className="text-xs text-(--color-text-tertiary)">· {hint}</span>
      </div>
      <p className="mt-1 text-xs text-(--color-text-secondary)">{description}</p>
    </div>
  );
}

export function SettingsIntegrations({
  githubStatus,
  onGitHubLogout,
  onGitHubTokenSubmit,
  hasActiveSession,
}: SettingsIntegrationsProps) {
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-5 py-4" data-testid="settings-integrations">
      {/* Tier 1 — curated, brokered, inline-rendered */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Connected services"
          hint="managed by ShipIt"
          description="First-party integrations. Credentials are brokered by ShipIt and never enter the session container; their data renders inline in chat."
        />
        <GitHubConnectionCard
          githubStatus={githubStatus}
          onGitHubLogout={onGitHubLogout}
          onGitHubTokenSubmit={onGitHubTokenSubmit}
        />
        <SettingsTrackers embedded logo={<LogoTile><LinearLogo /></LogoTile>} />
        <p className="text-xs text-(--color-text-tertiary)">
          More first-party integrations (Jira, Sentry, …) land here — not as “add your own”.
        </p>
      </section>

      <div className="h-px bg-(--color-border-secondary)" />

      {/* Tier 2 — user-supplied tools, bring-your-own-credentials */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="MCP servers"
          hint="bring your own tools"
          description="Extend the agent with your own tools via the Model Context Protocol. These run with the credentials you provide."
        />
        <McpServerSettings hasActiveSession={hasActiveSession} embedded />
      </section>
    </div>
  );
}

/** Re-exported so the Integrations section can frame Linear with a brand tile. */
export { LinearLogo };
