import { useState, useRef } from "react";
import type { AgentOption } from "./AgentPicker.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.js";
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import { CodexAuthCard } from "./CodexAuthCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { usePreviewStore, type DeclaredSecretState } from "../stores/preview-store.js";

const MAX_LENGTH = 50_000;

// On mobile the tab list collapses from a vertical sidebar into a horizontal
// scrollable strip — each trigger sizes to its label and gets pill-like styling
// so it reads as a tab bar rather than a stretched menu row.
const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

type Tab = "agent" | "github" | "git" | "instructions" | "advanced" | "deployments" | "secrets";

export interface SettingsProps {
  initialContent: string;
  onSaveInstructions: (content: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => void;
  onGitHubLogout: () => void;
  authUrl: string | null;
  onApiKey: (key: string) => void;
  onClearApiKey: () => void;
  onStartAuth: () => void;
  onPasteCode: (code: string) => void;
  agentList?: AgentOption[];
  onSetAgentEnv?: (agentId: string, key: string, value: string) => void;
  onFullReset?: () => void;
  gitIdentity: { name: string; email: string };
  onGitIdentitySave: (name: string, email: string) => void;
  maxIdleContainers: number;
  onMaxIdleContainersSave: (n: number) => void;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  onToggleAgentSystemInstructions: (enabled: boolean) => void;
  hasActiveSession: boolean;
  repoUrl?: string;
  onSecretsSave?: (repoUrl: string, secrets: Record<string, string>) => void;
  onSecretsLoad?: (repoUrl: string) => Promise<Record<string, string>>;
  onClose: () => void;
}

function ToggleSwitch({ enabled, onToggle, testId }: { enabled: boolean; onToggle: (v: boolean) => void; testId?: string }) {
  return (
    <button
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
      }`}
      role="switch"
      aria-checked={enabled}
      data-testid={testId}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function DisplaySettings() {
  const showSessionCost = useSettingsStore((s) => s.showSessionCost);
  const setShowSessionCost = useSettingsStore((s) => s.setShowSessionCost);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Display</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Show session cost</span>
            <p className="text-xs text-(--color-text-tertiary)">Display the running USD cost of the current session next to the chat input. Hide it if your provider subscription covers usage and you don't pay per call.</p>
          </div>
          <ToggleSwitch enabled={showSessionCost} onToggle={setShowSessionCost} testId="settings-show-session-cost" />
        </div>
      </div>
    </div>
  );
}

function NotificationSettings() {
  const notifyOnFinish = useSettingsStore((s) => s.notifyOnFinish);
  const soundOnFinish = useSettingsStore((s) => s.soundOnFinish);
  const setNotifyOnFinish = useSettingsStore((s) => s.setNotifyOnFinish);
  const setSoundOnFinish = useSettingsStore((s) => s.setSoundOnFinish);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Notifications</h3>
      <p className="text-sm text-(--color-text-secondary)">
        Get notified when the agent finishes a turn.
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Browser notification</span>
            <p className="text-xs text-(--color-text-tertiary)">Show a desktop notification when the tab is in the background</p>
          </div>
          <ToggleSwitch enabled={notifyOnFinish} onToggle={setNotifyOnFinish} testId="settings-notify-on-finish" />
        </div>
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Sound</span>
            <p className="text-xs text-(--color-text-tertiary)">Play a chime when the agent finishes</p>
          </div>
          <ToggleSwitch enabled={soundOnFinish} onToggle={setSoundOnFinish} testId="settings-sound-on-finish" />
        </div>
      </div>
    </div>
  );
}

/**
 * Pull-request automation settings (currently just auto-create PR).
 * Rendered inside the GitHub tab when the user is authenticated — without a
 * GitHub token the server-side gate (`githubAuthManager.authenticated` in
 * `claude-execution.ts`) means toggling this on is a no-op.
 *
 * Mirrors the optimistic-set-then-PUT-with-revert pattern that previously
 * lived in `PrLifecycleCard.tsx`'s `AutoCreatePrToggle`. Surfaces a toast on
 * failure (the inline toggle's silent console-only failure made sense next to
 * a busy PR card; in a quiet Settings dialog a visible error is better).
 */
// ---------------------------------------------------------------------------
// Secrets tab (087-reusable-preview-secrets, Phase 5 UI polish)
// ---------------------------------------------------------------------------

/**
 * Helper labels for `source: platform:*` declared secrets.
 * Mirrors `PLATFORM_SOURCES` on the server — kept in sync manually.
 */
const PLATFORM_SOURCE_LABELS: Record<string, string> = {
  "platform:claude_oauth": "Claude OAuth",
  "platform:github_token": "GitHub token",
};

interface SecretsTabProps {
  repoUrl?: string;
  onSecretsSave?: (repoUrl: string, secrets: Record<string, string>) => void;
  onSecretsLoad?: (repoUrl: string) => Promise<Record<string, string>>;
}

/**
 * Settings → Secrets tab. Renders three sections:
 *
 *   1. **Declared secrets** — from `x-shipit-secrets` in the active repo's
 *      compose file (live via the `secrets_status` WS message). Shows the
 *      description, required indicator, consumer-service chips, and an
 *      `agent`/`platform` badge when applicable. Platform-sourced rows are
 *      read-only.
 *   2. **Custom secrets** — env vars the user has saved but no compose
 *      service declared. They aren't injected anywhere (declaring them is
 *      the wiring), but we keep them visible so the user can clean up
 *      stale leftovers.
 *   3. A "+ Add custom variable" affordance for ad-hoc env vars.
 *
 * The Save button writes the union of declared values + custom entries
 * back to the repo's secret store via `PUT /api/secrets`.
 */
function SecretsTab({ repoUrl, onSecretsSave, onSecretsLoad }: SecretsTabProps) {
  // Live snapshot of declared secrets from the running compose stack.
  const declared = usePreviewStore((s) => s.secrets.declared);
  const missingByService = usePreviewStore((s) => s.secrets.missingByService);

  // User-saved values. Keyed by env var name. Loaded once when the tab opens.
  const [values, setValues] = useState<Record<string, string>>({});
  // Custom (user-added) entries that aren't in `declared`. Stored as an
  // ordered list so adding a new row keeps it in place; merged with `values`
  // on save.
  const [customRows, setCustomRows] = useState<{ key: string; value: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);

  // Lazy-load on first render. Subsequent re-renders skip.
  if (!loadedRef.current && repoUrl && onSecretsLoad) {
    loadedRef.current = true;
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget in render
    void onSecretsLoad(repoUrl).then((secrets) => {
      setValues(secrets);
      setLoaded(true);
    }).catch(() => {
      setLoaded(true);
    });
  }

  // Once the declared list loads, pull anything not declared into the custom
  // rows so the user can see and edit existing-but-undeclared values.
  // Re-runs whenever `declared` or `values` shape changes.
  const declaredNames = new Set(declared.map((d) => d.name));
  const inferredCustomRows = Object.entries(values)
    .filter(([k]) => !declaredNames.has(k))
    .map(([key, value]) => ({ key, value }));
  // Use the inferred rows as the source of truth on first render, then let
  // the user mutate via setCustomRows. We compare lengths as a cheap
  // freshness check — declared changes can demote rows from declared to
  // custom.
  const customRowsToShow = customRows.length > 0 ? customRows : inferredCustomRows;

  function setDeclaredValue(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    setSaved(false);
  }

  function setCustomKey(idx: number, key: string) {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      const next = [...base];
      next[idx] = { ...next[idx], key };
      return next;
    });
    setSaved(false);
  }

  function setCustomValue(idx: number, value: string) {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      const next = [...base];
      next[idx] = { ...next[idx], value };
      return next;
    });
    setSaved(false);
  }

  function removeCustomRow(idx: number) {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      return base.filter((_, i) => i !== idx);
    });
    setSaved(false);
  }

  function addCustomRow() {
    setCustomRows((rows) => {
      const base = rows.length > 0 ? rows : inferredCustomRows;
      return [...base, { key: "", value: "" }];
    });
    setSaved(false);
  }

  function save() {
    if (!repoUrl || !onSecretsSave) return;
    setSaving(true);
    const out: Record<string, string> = {};
    // Declared values first (those are guaranteed-unique names).
    for (const d of declared) {
      // Skip platform-sourced rows — they're not user-configurable.
      if (d.source?.startsWith("platform:")) continue;
      const v = values[d.name];
      if (typeof v === "string") out[d.name] = v;
    }
    // Custom rows (user-keyed), with empty-key / duplicate-key guards.
    for (const row of customRowsToShow) {
      const k = row.key.trim();
      if (!k) continue;
      out[k] = row.value;
    }
    onSecretsSave(repoUrl, out);
    setTimeout(() => {
      setSaving(false);
      setSaved(true);
    }, 500);
  }

  if (!loaded) {
    return <p className="text-sm text-(--color-text-tertiary)">Loading...</p>;
  }

  return (
    <>
      {/* Declared secrets (from x-shipit-secrets). Hidden when the repo's
          compose file declares nothing — the tab shrinks to the custom-only
          legacy form. */}
      {declared.length > 0 && (
        <section className="space-y-2" data-testid="secrets-declared-section">
          <header className="space-y-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-(--color-text-secondary)">
              Declared by your compose file
            </h4>
            <p className="text-xs text-(--color-text-tertiary)">
              From <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code>.
              Each value is injected only into the services that listed it.
            </p>
          </header>
          <div className="space-y-3">
            {declared.map((d) => (
              <DeclaredSecretRow
                key={d.name}
                requirement={d}
                value={values[d.name] ?? ""}
                missing={missingByService}
                onChange={(v) => setDeclaredValue(d.name, v)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Custom (undeclared) secrets — user-added values not referenced by
          any compose service. Always shown so users can clean up stale
          leftovers. */}
      <section className="space-y-2" data-testid="secrets-custom-section">
        <header className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-(--color-text-secondary)">
            Custom variables
          </h4>
          <p className="text-xs text-(--color-text-tertiary)">
            Stored for this repo but not yet referenced by any compose service.
            Add them to <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code> in your compose file to inject them.
          </p>
        </header>
        <div className="space-y-2">
          {customRowsToShow.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={row.key}
                onChange={(e) => setCustomKey(idx, e.target.value)}
                placeholder="KEY"
                className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                data-testid={`secret-key-${idx}`}
              />
              <input
                type="password"
                value={row.value}
                onChange={(e) => setCustomValue(idx, e.target.value)}
                placeholder="value"
                className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                data-testid={`secret-value-${idx}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeCustomRow(idx)}
                className="text-(--color-text-tertiary) hover:text-(--color-error) shrink-0"
                aria-label="Remove secret"
                data-testid={`secret-remove-${idx}`}
              >
                &times;
              </Button>
            </div>
          ))}
        </div>
        <button
          onClick={addCustomRow}
          className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors self-start"
          data-testid="secret-add"
        >
          + Add variable
        </button>
      </section>

      <div className="flex justify-end mt-2">
        <Button
          variant="primary"
          size="md"
          disabled={saving}
          onClick={save}
          className="rounded-md"
          data-testid="secrets-save"
        >
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </Button>
      </div>
    </>
  );
}

/**
 * One row in the declared-secrets section. Read-only for `source: platform:*`
 * entries (the user can't edit a forwarded credential — it's pulled from
 * orchestrator state). Otherwise, an editable password input scoped to the
 * declared name.
 */
function DeclaredSecretRow({
  requirement,
  value,
  missing,
  onChange,
}: {
  requirement: DeclaredSecretState;
  value: string;
  missing: Record<string, string[]>;
  onChange: (v: string) => void;
}) {
  const isPlatform = requirement.source?.startsWith("platform:");
  const platformLabel = requirement.source ? PLATFORM_SOURCE_LABELS[requirement.source] : null;
  // A name is "missing" when it's required AND any service that consumes it
  // has it on its missing list (which means no value resolved). Optional
  // missing values don't surface as a problem.
  const isMissing =
    requirement.required &&
    requirement.services.some((svc) => (missing[svc] ?? []).includes(requirement.name));

  return (
    <div
      className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary)/50 p-3 space-y-2"
      data-testid={`secret-declared-${requirement.name}`}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <code className="font-mono text-sm text-(--color-text-primary) break-all">
          {requirement.name}
        </code>
        {requirement.required && (
          <span
            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
              isMissing
                ? "bg-(--color-warning)/20 text-(--color-warning)"
                : "bg-(--color-bg-hover) text-(--color-text-secondary)"
            }`}
            data-testid={`secret-required-${requirement.name}`}
          >
            Required
          </span>
        )}
        {requirement.agent && (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-accent)/15 text-(--color-accent)"
            title="Also injected into the agent container"
            data-testid={`secret-agent-${requirement.name}`}
          >
            Agent
          </span>
        )}
        {isPlatform && (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-bg-hover) text-(--color-text-secondary)"
            title={`Resolved from ${platformLabel ?? requirement.source}`}
            data-testid={`secret-platform-${requirement.name}`}
          >
            Platform
          </span>
        )}
      </div>

      {requirement.description && (
        <p className="text-xs text-(--color-text-secondary)">{requirement.description}</p>
      )}

      <div className="flex items-center gap-2 text-[11px] text-(--color-text-tertiary) flex-wrap">
        <span>Used by:</span>
        {requirement.services.map((svc) => (
          <span
            key={svc}
            className="px-1.5 py-0.5 rounded bg-(--color-bg-hover) text-(--color-text-secondary)"
          >
            {svc}
          </span>
        ))}
      </div>

      {isPlatform ? (
        <div className="text-xs text-(--color-text-tertiary) italic">
          {platformLabel
            ? `Provided automatically from your ${platformLabel}.`
            : `Provided automatically (${requirement.source}).`}
        </div>
      ) : (
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={requirement.required ? "Required — set a value" : "value (optional)"}
          className="w-full rounded-md bg-(--color-bg-primary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
          data-testid={`secret-value-${requirement.name}`}
        />
      )}
    </div>
  );
}

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
      // Revert the optimistic update and surface the failure.
      useSettingsStore.getState().setAutoCreatePr(!v);
      useUiStore.getState().setToast({ message: "Failed to update auto-create PR setting" });
      console.error("[settings] toggle autoCreatePr failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Pull Requests</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Auto-create PR after every meaningful turn</span>
            <p className="text-xs text-(--color-text-tertiary)">When the agent finishes a turn that changes files, ShipIt opens a pull request automatically.</p>
          </div>
          <ToggleSwitch enabled={autoCreatePr} onToggle={(v) => void handleToggle(v)} testId="settings-auto-create-pr" />
        </div>
      </div>
    </div>
  );
}

export function Settings({
  initialContent,
  onSaveInstructions,
  githubStatus,
  onGitHubTokenSubmit,
  onGitHubLogout,
  authUrl,
  onApiKey,
  onClearApiKey,
  onStartAuth,
  onPasteCode,
  agentList = [],
  onSetAgentEnv,
  onFullReset,
  gitIdentity,
  onGitIdentitySave,
  maxIdleContainers,
  onMaxIdleContainersSave,
  agentSystemInstructionsEnabled,
  agentSystemInstructions,
  onToggleAgentSystemInstructions,
  hasActiveSession,
  repoUrl,
  onSecretsSave,
  onSecretsLoad,
  onClose,
}: SettingsProps) {
  const activeTab = useUiStore((s) => s.settingsTab) ?? "agent";
  const setActiveTab = useUiStore((s) => s.setSettingsTab);
  const [content, setContent] = useState(initialContent);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [gitName, setGitName] = useState(gitIdentity.name);
  const [gitEmail, setGitEmail] = useState(gitIdentity.email);
  const [gitSaved, setGitSaved] = useState(false);
  const [idleContainers, setIdleContainers] = useState(maxIdleContainers);
  const [idleContainersSaved, setIdleContainersSaved] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    available: boolean; behindBy: number; commitMessages: string[]; currentCommit: string;
  } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);


  // Sync local git identity state when props change (e.g. fetched from server)
  const prevGitIdentityRef = useRef(gitIdentity);
  if (prevGitIdentityRef.current.name !== gitIdentity.name || prevGitIdentityRef.current.email !== gitIdentity.email) {
    prevGitIdentityRef.current = gitIdentity;
    setGitName(gitIdentity.name);
    setGitEmail(gitIdentity.email);
  }

  const handleSave = () => {
    savedRef.current = true;
    onSaveInstructions(content);
  };

  const handleClose = () => {
    if (!savedRef.current) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (activeTab === "instructions" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  const charCount = content.length;
  const isOverLimit = charCount > MAX_LENGTH;

  const claudeAgent = agentList.find((a) => a.id === "claude");
  const codexAgent = agentList.find((a) => a.id === "codex");

  const generalTabs = ["agent", "github", "git", "instructions", "advanced"] as const;
  const tabLabel = (tab: Tab) => {
    switch (tab) {
      case "agent": return "Agent";
      case "github": return "GitHub";
      case "git": return "Git";
      case "instructions": return "Instructions";
      case "advanced": return "Advanced";
      case "deployments": return "Deployments";
      case "secrets": return "Secrets";
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-2xl w-full md:mx-4 flex flex-col md:h-120 max-md:h-full"
        data-testid="settings-backdrop"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </Button>
        </div>

        {/* Body: sidebar tabs + content (vertical sidebar on desktop, horizontal scroll strip on mobile) */}
        <Tabs value={activeTab} onValueChange={(v) => {
          const tab = v as Tab;
          if (tab === "secrets" && !hasActiveSession) return;
          setActiveTab(tab);
          if (tab === "instructions") {
            requestAnimationFrame(() => textareaRef.current?.focus());
          }
        }} className="flex max-md:flex-col flex-1 min-h-0" orientation="vertical">
          {/* Tab list — vertical sidebar on desktop, horizontal scroll on mobile */}
          <TabsList className="md:w-40 md:shrink-0 md:border-r md:py-2 max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 max-md:gap-1 max-md:shrink-0 border-(--color-border-secondary)">
            <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary) max-md:hidden">
              General
            </div>
            {generalTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab} className={mobileTabClass}>
                {tabLabel(tab)}
              </TabsTrigger>
            ))}

            <div className="px-4 py-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary) max-md:hidden">
              Project
            </div>
            <TabsTrigger value="deployments" data-testid="settings-tab-deployments" className={mobileTabClass}>
              Deployments
            </TabsTrigger>
            <TabsTrigger
              value="secrets"
              disabled={!hasActiveSession}
              title={!hasActiveSession ? "Requires active session" : undefined}
              data-testid="settings-tab-secrets"
              className={mobileTabClass}
            >
              Secrets
            </TabsTrigger>
          </TabsList>

          {/* Right content area */}
          <TabsContent value="agent">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <ClaudeAuthCard
                agent={claudeAgent}
                authUrl={authUrl}
                onStartAuth={onStartAuth}
                onApiKeySubmit={async (key) => { onApiKey(key); return undefined; }}
                onPasteAuthCode={onPasteCode}
                onClearApiKey={onClearApiKey}
                showApiKeyWhenAuthed
              />

              {codexAgent && (
                <div className="pt-2 border-t border-(--color-border-secondary)">
                  <CodexAuthCard
                    agent={codexAgent}
                    onApiKeySubmit={async (key) => { onSetAgentEnv?.("codex", "OPENAI_API_KEY", key); return undefined; }}
                  />
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="instructions">
            <div className="px-5 py-4 flex flex-col gap-3 overflow-y-auto h-full">
              {/* Agent system instructions (built-in) */}
              <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 space-y-2" data-testid="agent-system-instructions">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-(--color-text-primary)">ShipIt Agent Instructions</h3>
                    <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                      Built-in context sent with every message to help the agent understand the ShipIt environment.
                    </p>
                  </div>
                  <button
                    onClick={() => onToggleAgentSystemInstructions(!agentSystemInstructionsEnabled)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      agentSystemInstructionsEnabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
                    }`}
                    role="switch"
                    aria-checked={agentSystemInstructionsEnabled}
                    data-testid="agent-instructions-toggle"
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                        agentSystemInstructionsEnabled ? "translate-x-4.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
                {agentSystemInstructions && (
                  <div>
                    <button
                      onClick={() => setInstructionsExpanded(!instructionsExpanded)}
                      className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
                      data-testid="agent-instructions-expand"
                    >
                      {instructionsExpanded ? "Hide instructions" : "View instructions"}
                    </button>
                    {instructionsExpanded && (
                      <pre className="mt-2 text-xs text-(--color-text-secondary) whitespace-pre-wrap bg-(--color-bg-primary) rounded-md p-2 border border-(--color-border-secondary) max-h-48 overflow-y-auto" data-testid="agent-instructions-content">
                        {agentSystemInstructions}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-(--color-border-secondary)" />

              {/* User custom instructions */}
              <div>
                <h3 className="text-sm font-medium text-(--color-text-primary) mb-1">Your Instructions</h3>
                <p className="text-xs text-(--color-text-secondary) mb-2">
                  Custom instructions sent to the agent with every message. Use them to define project
                  conventions, preferred libraries, or style guidelines.
                </p>
              </div>

              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
                className="flex-1 min-h-30 w-full bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded-md px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) resize-none focus:outline-none focus:border-(--color-border-focus)"
                data-testid="settings-textarea"
              />

              <div className="flex items-center justify-between text-xs text-(--color-text-secondary)">
                <span>
                  Note: The agent also reads CLAUDE.md from your workspace root automatically.
                </span>
                <span className={isOverLimit ? "text-(--color-error)" : ""}>
                  {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={onClose}
                  className="rounded-md"
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleSave}
                  disabled={isOverLimit}
                  className="rounded-md"
                  data-testid="settings-save"
                >
                  Save
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="github">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              {githubStatus.authenticated ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary)">
                    <span className="w-2.5 h-2.5 rounded-full bg-(--color-success) shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-(--color-text-primary)">
                        {githubStatus.username ?? "GitHub"}
                      </p>
                      <p className="text-xs text-(--color-text-secondary)">Connected</p>
                    </div>
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
                    className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
                      disconnecting
                        ? "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-tertiary) opacity-50 cursor-not-allowed"
                        : confirmingLogout
                          ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error)"
                          : "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                    }`}
                    data-testid="settings-disconnect"
                  >
                    {disconnecting ? "Disconnecting..." : confirmingLogout ? "Click again to disconnect" : "Disconnect"}
                  </button>

                  <div className="border-t border-(--color-border-secondary)" />

                  <PullRequestSettings />
                </div>
              ) : (
                <GitHubTokenForm onSubmit={async (t) => { onGitHubTokenSubmit(t); return undefined; }} />
              )}
            </div>
          </TabsContent>

          <TabsContent value="git">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <div className="space-y-4">
                <p className="text-sm text-(--color-text-secondary)">
                  Git identity used for automatic commits in all sessions.
                </p>

                <div>
                  <label className="block text-sm font-medium text-(--color-text-primary) mb-1">Name</label>
                  <input
                    type="text"
                    value={gitName}
                    onChange={(e) => { setGitName(e.target.value); setGitSaved(false); }}
                    placeholder="Your Name"
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
                    data-testid="settings-git-name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-(--color-text-primary) mb-1">Email</label>
                  <input
                    type="email"
                    value={gitEmail}
                    onChange={(e) => { setGitEmail(e.target.value); setGitSaved(false); }}
                    placeholder="you@example.com"
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
                    data-testid="settings-git-email"
                  />
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => {
                    onGitIdentitySave(gitName.trim(), gitEmail.trim());
                    setGitSaved(true);
                  }}
                  disabled={!gitName.trim() || !gitEmail.trim()}
                  className="w-full rounded-lg"
                  data-testid="settings-git-save"
                >
                  {gitSaved ? "Saved" : "Save"}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="advanced">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <DisplaySettings />

              <div className="border-t border-(--color-border-secondary)" />

              <NotificationSettings />

              <div className="border-t border-(--color-border-secondary)" />

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Max Idle Containers</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Maximum Docker containers kept running when not in use. Containers beyond this limit are stopped. Set to 0 to stop all idle containers immediately.
                </p>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={0}
                    value={idleContainers}
                    onChange={(e) => { setIdleContainers(Math.max(0, Math.floor(Number(e.target.value) || 0))); setIdleContainersSaved(false); }}
                    className="w-24 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
                    data-testid="settings-max-idle-containers"
                  />
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => { onMaxIdleContainersSave(idleContainers); setIdleContainersSaved(true); }}
                    className="rounded-md"
                    data-testid="settings-max-idle-containers-save"
                  >
                    {idleContainersSaved ? "Saved" : "Save"}
                  </Button>
                </div>
              </div>

              <div className="border-t border-(--color-border-secondary)" />

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Software Updates</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Check for new versions and update ShipIt in place.
                </p>
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <Button
                    variant="primary"
                    size="md"
                    disabled={updateChecking || updateApplying}
                    onClick={async () => {
                      setUpdateChecking(true);
                      setUpdateError(null);
                      try {
                        const res = await fetch("/api/updates/check", { method: "POST" });
                        if (!res.ok) {
                          const body = await res.json().catch(() => ({})) as { error?: string };
                          throw new Error(body.error ?? `HTTP ${res.status}`);
                        }
                        const data = await res.json() as { available: boolean; behindBy: number; commitMessages: string[]; currentCommit: string };
                        setUpdateStatus(data);
                      } catch (err) {
                        setUpdateError((err as Error).message);
                      } finally {
                        setUpdateChecking(false);
                      }
                    }}
                    className="rounded-md"
                    data-testid="settings-check-updates"
                  >
                    {updateChecking ? "Checking..." : "Check for Updates"}
                  </Button>
                  {updateStatus?.available && !updateApplying && (
                    <Button
                      variant="primary"
                      size="md"
                      onClick={async () => {
                        setUpdateApplying(true);
                        setUpdateError(null);
                        try {
                          const res = await fetch("/api/updates/apply", { method: "POST" });
                          if (!res.ok) {
                            const body = await res.json().catch(() => ({})) as { error?: string };
                            throw new Error(body.error ?? `HTTP ${res.status}`);
                          }
                        } catch (err) {
                          setUpdateApplying(false);
                          setUpdateError((err as Error).message);
                        }
                      }}
                      className="rounded-md"
                      data-testid="settings-apply-update"
                    >
                      Update Now
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={restarting || updateApplying}
                    onClick={async () => {
                      setRestarting(true);
                      setUpdateError(null);
                      try {
                        const res = await fetch("/api/updates/restart", { method: "POST" });
                        if (!res.ok) {
                          const body = await res.json().catch(() => ({})) as { error?: string };
                          throw new Error(body.error ?? `HTTP ${res.status}`);
                        }
                      } catch (err) {
                        setRestarting(false);
                        setUpdateError((err as Error).message);
                      }
                    }}
                    className="rounded-md"
                    data-testid="settings-restart"
                  >
                    {restarting ? "Restarting..." : "Just Restart"}
                  </Button>
                </div>
                {updateApplying && (
                  <p className="text-sm text-(--color-text-secondary)">
                    Updating... ShipIt will restart momentarily. Refresh the page in a few seconds.
                  </p>
                )}
                {restarting && (
                  <p className="text-sm text-(--color-text-secondary)">
                    Restarting... ShipIt will be back momentarily. Refresh the page in a few seconds.
                  </p>
                )}
                {updateError && (
                  <p className="text-sm text-(--color-error)">{updateError}</p>
                )}
                {updateStatus && !updateApplying && (
                  <div className="text-sm text-(--color-text-secondary)">
                    {updateStatus.available ? (
                      <>
                        <p>{updateStatus.behindBy} update{updateStatus.behindBy === 1 ? "" : "s"} available</p>
                        <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs font-mono text-(--color-text-tertiary)">
                          {updateStatus.commitMessages.slice(0, 10).map((msg, i) => (
                            <li key={i}>{msg}</li>
                          ))}
                          {updateStatus.behindBy > 10 && <li>...and {updateStatus.behindBy - 10} more</li>}
                        </ul>
                      </>
                    ) : (
                      <p>ShipIt is up to date ({updateStatus.currentCommit.slice(0, 7)})</p>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-(--color-border-secondary)" />

              <div className="space-y-4">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Reset Container</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Delete all sessions, chat history, and settings. Credentials (GitHub, Claude) are preserved. This cannot be undone.
                </p>
                <button
                  onClick={() => {
                    if (confirmingReset) {
                      setResetting(true);
                      onFullReset?.();
                    } else {
                      setConfirmingReset(true);
                    }
                  }}
                  onBlur={() => {
                    if (!resetting) setConfirmingReset(false);
                  }}
                  disabled={resetting}
                  className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
                    resetting
                      ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error) opacity-50 cursor-not-allowed"
                      : confirmingReset
                        ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error)"
                        : "bg-(--color-error-subtle) border-(--color-error)/30 text-(--color-error) hover:border-(--color-error)/50"
                  }`}
                  data-testid="settings-reset"
                >
                  {resetting ? "Resetting..." : confirmingReset ? "Click again to confirm reset" : "Reset Everything"}
                </button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="deployments">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="deployments-tab">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Automatic Deployments</h3>
                <p className="text-xs text-(--color-text-secondary)">
                  Connect your repo to a hosting platform for automatic deploys on every push. ShipIt auto-pushes after every Claude turn, so your site stays in sync.
                </p>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wider">Connect your repo</h4>
                {[
                  { name: "Vercel", url: "https://vercel.com/new", description: "Best for Next.js, React, and static sites" },
                  { name: "Cloudflare Pages", url: "https://dash.cloudflare.com/?to=/:account/pages/new/provider/github", description: "Fast global CDN with edge functions" },
                  { name: "Netlify", url: "https://app.netlify.com/start", description: "Simple deploys with form handling and functions" },
                ].map((platform) => (
                  <a
                    key={platform.name}
                    href={platform.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-3 rounded-lg border border-(--color-border-secondary) hover:border-(--color-border-focus) transition-colors"
                  >
                    <div className="text-sm font-medium text-(--color-text-primary)">{platform.name}</div>
                    <div className="text-xs text-(--color-text-secondary) mt-0.5">{platform.description}</div>
                  </a>
                ))}
              </div>

              <div className="space-y-1 mt-2">
                <h4 className="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wider">How it works</h4>
                <ol className="text-xs text-(--color-text-secondary) space-y-1.5 list-decimal list-inside">
                  <li>Import your GitHub repo on the platform above</li>
                  <li>ShipIt pushes code after every Claude turn</li>
                  <li>The platform builds and deploys automatically</li>
                  <li>Deploy status appears in the PR card</li>
                </ol>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="secrets">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="secrets-tab">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Environment Variables</h3>
                <p className="text-xs text-(--color-text-secondary)">
                  Secrets are injected into the services that declare them in <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code>. The agent only sees values you explicitly mark with <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">agent: true</code>.
                </p>
              </div>
              <SecretsTab
                repoUrl={repoUrl}
                onSecretsSave={onSecretsSave}
                onSecretsLoad={onSecretsLoad}
              />
            </div>
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
