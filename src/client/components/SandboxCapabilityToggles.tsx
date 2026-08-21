/**
 * docs/211 / docs/279 — the four sandbox capability toggles, with the inline
 * notes explaining what each grant actually widens.
 *
 * Extracted from `SandboxDialog` because the grants are no longer chosen only at
 * creation (docs/279 req 1): the creation dialog and the per-session Session
 * settings dialog both render this, so the two surfaces cannot end up describing
 * the same grant differently — which matters more here than for ordinary UI
 * reuse, since the notes are what the user's trust decision is based on.
 *
 * Stateless: the owner holds the set and applies the returned one. The sub-grant
 * rule (docs/224 — "Allow merging PRs" is meaningless without GitHub access) is
 * applied here so both callers get it, and again server-side in
 * `normalizeCapabilities`, which is the copy that actually enforces it.
 */

import { GitBranchIcon, ShippingContainerIcon, GlobeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { SessionCapabilities } from "../../server/shared/types.js";

export function SandboxCapabilityToggles({
  capabilities,
  onChange,
  disabled = false,
}: {
  capabilities: SessionCapabilities;
  onChange: (next: SessionCapabilities) => void;
  /** True while a write is in flight, or before the set has loaded. */
  disabled?: boolean;
}) {
  const toggle = (key: keyof SessionCapabilities) => {
    const next = { ...capabilities, [key]: !capabilities[key] };
    // "Allow merging PRs" is a sub-grant of GitHub access — turning git off
    // clears it so a re-enabled toggle never silently carries a stale grant.
    if (key === "git" && !next.git) next.dangerousGitHubOps = false;
    onChange(next);
  };

  return (
    <>
      <ToggleRow
        icon={<GitBranchIcon size={ICON_SIZE.SM} />}
        title="GitHub access"
        chip={{ label: "recommended", on: true }}
        desc="Credential broker for git & gh — clone and push private repos, open PRs."
        note={{
          tone: "warn",
          text: "The session can reach any repo your account can. Off = no GitHub token (public clones only, no push) — not a network seal; use Network access for that.",
        }}
        checked={capabilities.git}
        disabled={disabled}
        onToggle={() => toggle("git")}
      />
      <SubToggleRow
        title="Allow merging PRs"
        chip={{ label: "dangerous" }}
        desc="Let the agent run gh pr merge to land PRs — gated on green checks, never force-merges."
        note="Merging is outward-facing, effectively irreversible, and the action most exposed to prompt-injection from PR content. Off by default; only the agent in this sandbox is affected."
        checked={capabilities.git && capabilities.dangerousGitHubOps}
        disabled={disabled || !capabilities.git}
        disabledHint="Turn on GitHub access first."
        onToggle={() => toggle("dangerousGitHubOps")}
      />
      <ToggleRow
        icon={<ShippingContainerIcon size={ICON_SIZE.SM} />}
        title="Docker access"
        desc="Build & run containers through a session-scoped proxy."
        note={{
          tone: "ok",
          text: "Isolated to this session: only its own containers/networks/volumes. No host socket, no --privileged.",
        }}
        checked={capabilities.docker}
        disabled={disabled}
        onToggle={() => toggle("docker")}
      />
      <ToggleRow
        icon={<GlobeIcon size={ICON_SIZE.SM} />}
        title="Network access"
        chip={{ label: "on by default", on: true }}
        desc="On = the standard allowlist (LLM, GitHub, registries) with inline approval for new hosts — same as a normal session."
        note={{
          tone: "warn",
          text: "Off = no internet beyond the agent's lifeline (LLM + ShipIt) — plus GitHub if granted above. No registries or web.",
        }}
        checked={capabilities.network}
        disabled={disabled}
        onToggle={() => toggle("network")}
      />
    </>
  );
}

/**
 * docs/224 — an indented sub-grant under a parent capability (here, "Allow
 * merging PRs" under GitHub access). Visually nested and dimmed/disabled until
 * its parent is on, so the dependency reads at a glance.
 */
function SubToggleRow({
  title,
  chip,
  desc,
  note,
  checked,
  disabled,
  disabledHint,
  onToggle,
}: {
  title: string;
  chip?: { label: string };
  desc: string;
  note: string;
  checked: boolean;
  disabled: boolean;
  disabledHint: string;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex gap-3 py-3 pl-11 border-t border-(--color-border-primary) ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-(--color-text-primary)">
          {title}
          {chip && (
            <span className="text-[11px] font-medium px-1.5 rounded-full bg-(--color-warning-subtle) text-(--color-warning)">
              {chip.label}
            </span>
          )}
        </div>
        <p className="text-xs text-(--color-text-secondary) mt-0.5">{desc}</p>
        <p className="text-[11px] mt-1.5 px-2 py-1 rounded-md border bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning-subtle)">
          {disabled ? disabledHint : note}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onToggle}
        className={`relative w-9.5 h-5.5 rounded-full shrink-0 mt-0.5 transition-colors border ${
          disabled ? "cursor-not-allowed" : ""
        } ${
          checked
            ? "bg-(--color-sandbox) border-(--color-sandbox)"
            : "bg-(--color-bg-tertiary) border-(--color-border-secondary)"
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left] ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  chip,
  desc,
  note,
  checked,
  disabled,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  chip?: { label: string; on: boolean };
  desc: string;
  note: { tone: "warn" | "ok"; text: string };
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex gap-3 py-3.5 border-t border-(--color-border-primary) first:border-t-0">
      <span className="w-8 h-8 rounded-lg bg-(--color-bg-tertiary) text-(--color-text-secondary) flex items-center justify-center shrink-0">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-(--color-text-primary)">
          {title}
          {chip && (
            <span className="text-[11px] font-medium px-1.5 rounded-full bg-(--color-sandbox-subtle) text-(--color-sandbox)">
              {chip.label}
            </span>
          )}
        </div>
        <p className="text-xs text-(--color-text-secondary) mt-0.5">{desc}</p>
        <p
          className={`text-[11px] mt-1.5 px-2 py-1 rounded-md border ${
            note.tone === "warn"
              ? "bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning-subtle)"
              : "bg-(--color-success-subtle) text-(--color-success) border-(--color-success-border)"
          }`}
        >
          {note.text}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onToggle}
        className={`relative w-9.5 h-5.5 rounded-full shrink-0 mt-0.5 transition-colors border disabled:cursor-not-allowed ${
          checked
            ? "bg-(--color-sandbox) border-(--color-sandbox)"
            : "bg-(--color-bg-tertiary) border-(--color-border-secondary)"
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left] ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
