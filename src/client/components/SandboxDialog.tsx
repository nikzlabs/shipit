import { useState } from "react";
import { CubeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { SandboxCapabilityToggles } from "./SandboxCapabilityToggles.js";
import { DEFAULT_SANDBOX_CAPABILITIES, type SessionCapabilities } from "../../server/shared/types.js";

/**
 * docs/211 — capability picker for a NEW Sandbox session. Renders the shared
 * `SandboxCapabilityToggles` and returns the chosen set to the caller, which
 * POSTs it to `/api/sessions/sandbox`.
 *
 * Since docs/279 this is no longer the only place the grants are chosen — they
 * are editable afterwards from the session's Session settings dialog, which
 * renders the same toggles. This one still exists because the choice has to be
 * made before the first container boots: it is what the session STARTS as.
 * Network defaults on; GitHub and Docker default off (opt-in trust expansions).
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
              Starts with an empty workspace. Choose what the agent may use — you can change this later.
            </DialogDescription>
          </div>
        </div>

        <div className="px-5 pt-1.5">
          <SandboxCapabilityToggles capabilities={caps} onChange={setCaps} disabled={creating} />
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
