import { useState } from "react";
import { CubeIcon, GitBranchIcon, ShippingContainerIcon, GlobeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { DEFAULT_SANDBOX_CAPABILITIES, type SessionCapabilities } from "../../server/shared/types.js";

/**
 * docs/211 — capability picker for a new Sandbox session. Renders the three
 * independent, per-session capability toggles from the design (GitHub access,
 * Docker access, Network access) with inline limitation notes, and returns the
 * chosen set to the caller, which POSTs it to `/api/sessions/sandbox`.
 *
 * The grants are immutable once the session is created (server-authoritative),
 * so this dialog is the only place they're chosen. Network defaults on; GitHub
 * and Docker default off (opt-in trust expansions).
 */
export function SandboxDialog({
  open,
  onOpenChange,
  onCreate,
  creating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (capabilities: SessionCapabilities) => void;
  creating: boolean;
}) {
  const [caps, setCaps] = useState<SessionCapabilities>(DEFAULT_SANDBOX_CAPABILITIES);

  // Reset to defaults each time the dialog opens so a cancelled-then-reopened
  // flow never carries stale toggles.
  const reset = () => setCaps(DEFAULT_SANDBOX_CAPABILITIES);

  const toggle = (key: keyof SessionCapabilities) =>
    setCaps((c) => {
      const next = { ...c, [key]: !c[key] };
      // "Allow merging PRs" is a sub-grant of GitHub access — turning git off
      // clears it so a re-enabled toggle never silently carries a stale grant.
      if (key === "git" && !next.git) next.dangerousGitHubOps = false;
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="w-[460px] max-w-[92vw] p-0">
        <div className="flex items-center gap-2.5 px-5 pt-4.5 pb-1.5">
          <span className="w-8.5 h-8.5 rounded-lg bg-(--color-sandbox-subtle) text-(--color-sandbox) flex items-center justify-center shrink-0">
            <CubeIcon size={ICON_SIZE.MD} weight="fill" />
          </span>
          <div>
            <DialogTitle className="text-base">New Sandbox session</DialogTitle>
            <DialogDescription className="text-xs">
              Starts with an empty workspace. Choose what the agent may use.
            </DialogDescription>
          </div>
        </div>

        <div className="px-5 pt-1.5">
          <ToggleRow
            icon={<GitBranchIcon size={ICON_SIZE.SM} />}
            title="GitHub access"
            chip={{ label: "recommended", on: true }}
            desc="Credential broker for git & gh — clone and push private repos, open PRs."
            note={{
              tone: "warn",
              text: "The session can reach any repo your account can. Off = no GitHub token (public clones only, no push) — not a network seal; use Network access for that.",
            }}
            checked={caps.git}
            onToggle={() => toggle("git")}
          />
          <SubToggleRow
            title="Allow merging PRs"
            chip={{ label: "dangerous" }}
            desc="Let the agent run gh pr merge to land PRs — gated on green checks, never force-merges."
            note="Merging is outward-facing, effectively irreversible, and the action most exposed to prompt-injection from PR content. Off by default; only the agent in this sandbox is affected."
            checked={caps.git && caps.dangerousGitHubOps}
            disabled={!caps.git}
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
            checked={caps.docker}
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
            checked={caps.network}
            onToggle={() => toggle("network")}
          />
        </div>

        <div className="flex items-center justify-between gap-2.5 px-5 pt-3.5 pb-4.5">
          <p className="text-[11px] text-(--color-text-tertiary) max-w-[230px]">
            No live preview or PR card — manage branches &amp; PRs with{" "}
            <code className="text-[10px]">gh</code>.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={() => onCreate(caps)}
              disabled={creating}
              className="bg-(--color-sandbox) text-(--color-text-inverse) hover:brightness-110 border-(--color-sandbox)"
            >
              {creating ? "Creating…" : "Create sandbox"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  chip?: { label: string; on: boolean };
  desc: string;
  note: { tone: "warn" | "ok"; text: string };
  checked: boolean;
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
        onClick={onToggle}
        className={`relative w-9.5 h-5.5 rounded-full shrink-0 mt-0.5 transition-colors border ${
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
