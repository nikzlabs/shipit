/**
 * PermissionRequestCard — inline approve/deny card for a gated agent action
 * (docs/193 / SHI-112).
 *
 * Rendered where an agent backend gated an action it can't auto-approve
 * headlessly and asked the user to approve it. The classification is the
 * BACKEND's, not ShipIt's — ShipIt has no sensitive-file matcher of its own; it
 * faithfully surfaces whatever the CLI routed through its permission gate (a
 * file it deems sensitive like `.npmrc` / `.env`, or any other action it won't
 * take unattended). The copy is deliberately generic ("needs your approval")
 * rather than asserting a specific reason ShipIt doesn't actually know.
 * Approving lets the agent's next write succeed; "Approve & remember" also stops
 * re-prompting for that file this session. Denying tells the agent to find
 * another path.
 *
 * Agent-agnostic: the same card renders for Claude (its `--permission-prompt-tool`
 * gate) and Codex (its app-server escalation approval). Lifecycle (from the
 * permission store, keyed by requestId): pending → approved | denied | expired.
 */

import {
  CheckCircleIcon,
  LockKeyIcon,
  ProhibitIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { usePermissionStore } from "../stores/permission-store.js";

export interface PermissionRequestCardProps {
  requestId: string;
  onResolve?: (requestId: string, behavior: "allow" | "deny", remember?: boolean) => void;
}

export function PermissionRequestCard({ requestId, onResolve }: PermissionRequestCardProps) {
  const card = usePermissionStore((s) => s.cards[requestId]);
  const setPending = usePermissionStore((s) => s.setPending);

  if (!card) return null;

  const target = card.path ?? card.summary ?? card.toolName;

  // ── Terminal states ──
  if (card.phase !== "pending") {
    const resolved = {
      approved: {
        icon: <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />,
        color: "text-(--color-success)",
        label: card.remembered ? "Approved — remembered for this session" : "Approved",
      },
      denied: {
        icon: <ProhibitIcon size={ICON_SIZE.SM} weight="fill" />,
        color: "text-(--color-error)",
        label: "Denied",
      },
    }[card.phase];
    return (
      <div
        data-testid="permission-request-card"
        className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex items-center gap-2"
      >
        <span className={`shrink-0 ${resolved.color}`}>{resolved.icon}</span>
        <div className="min-w-0 flex-1 text-(--color-text-primary)">
          {resolved.label}
          <span className="text-(--color-text-tertiary)"> · {target}</span>
        </div>
      </div>
    );
  }

  const resolve = (behavior: "allow" | "deny", remember?: boolean) => {
    setPending(requestId); // keep optimistic; server flips to terminal on confirm
    onResolve?.(requestId, behavior, remember);
  };

  // Only file edits (a known path) can be remembered for the session.
  const canRemember = !!card.path;

  return (
    <div
      data-testid="permission-request-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs flex flex-col gap-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-(--color-accent)">
          <LockKeyIcon size={ICON_SIZE.SM} />
        </span>
        <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
          Permission needed
        </div>
      </div>

      <div className="text-(--color-text-primary)">
        The agent wants to <span className="font-medium">{card.toolName}</span>
        {card.path ? (
          <>
            {" "}
            <code className="rounded bg-(--color-bg-primary) px-1 py-0.5 font-mono text-[11px] break-all">
              {card.path}
            </code>
            {" "}and needs your approval.
          </>
        ) : (
          <>: {card.summary ?? "an action that needs your approval"}.</>
        )}
      </div>
      <div className="text-(--color-text-tertiary) text-[11px]">
        Approve to let the change through, or deny to have the agent try another way.
      </div>

      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button variant="ghost" size="md" onClick={() => resolve("deny")}>
          Deny
        </Button>
        {canRemember && (
          <Button variant="secondary" size="md" onClick={() => resolve("allow", true)}>
            Approve &amp; remember
          </Button>
        )}
        <Button variant="primary" size="md" onClick={() => resolve("allow")}>
          Approve
        </Button>
      </div>
    </div>
  );
}
