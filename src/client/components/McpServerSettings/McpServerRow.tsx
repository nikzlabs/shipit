import { Button } from "../ui/button.js";
import { useMcpStore } from "../../stores/mcp-store.js";
import { McpTestResult } from "./McpTestResult.js";
import type { McpServerConfig, McpTestResult as McpTestResultData } from "../../../server/shared/types.js";

/** Per-server runtime status pill driven by `mcp_server_status` WS events. */
export function StatusBadge({ name }: { name: string }) {
  const status = useMcpStore((s) => s.statuses[name]);
  if (!status) return null;
  const color =
    status.state === "loaded"
      ? "text-(--color-success)"
      : status.state === "failed"
        ? "text-(--color-error)"
        : status.state === "crashed"
          ? "text-(--color-warning)"
          : "text-(--color-text-tertiary)";
  return (
    <span className={`text-xs ${color}`} title={status.reason}>
      ● {status.state}
      {status.reason ? ` — ${status.reason}` : ""}
    </span>
  );
}

/**
 * A single standalone (non-OAuth-managed) server row: name, type, status
 * badge, the via-connection badge for orphaned OAuth entries, and the
 * Enable/Disable / Test / Edit / Delete actions plus the inline test result.
 */
export function McpServerRow({
  server,
  result,
  isToggling,
  isDeleting,
  hasActiveSession,
  managedBy,
  onToggle,
  onTest,
  onEdit,
  onDelete,
}: {
  server: McpServerConfig;
  result: McpTestResultData | "loading" | undefined;
  isToggling: boolean;
  isDeleting: boolean;
  hasActiveSession: boolean;
  managedBy: string | null;
  onToggle: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isTesting = result === "loading";
  return (
    <li
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex flex-col gap-2"
      data-testid={`mcp-server-${server.name}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-(--color-text-primary) truncate">
            {server.name}
          </span>
          <span className="text-xs text-(--color-text-tertiary)">{server.type}</span>
          {managedBy && (
            <span
              className="text-xs text-(--color-text-tertiary)"
              title={`Authentication is managed by your ${managedBy} connection above. Use Disconnect there to revoke access.`}
            >
              · via {managedBy} connection
            </span>
          )}
          {!server.enabled && (
            <span className="text-xs text-(--color-text-tertiary)">(disabled)</span>
          )}
          <StatusBadge name={server.name} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="md"
            variant="ghost"
            onClick={onToggle}
            disabled={isToggling || isDeleting}
          >
            {isToggling ? "…" : server.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="md"
            variant="ghost"
            onClick={onTest}
            disabled={!hasActiveSession || isTesting || isDeleting}
            title={hasActiveSession ? undefined : "Start a session to test"}
          >
            {isTesting ? "Testing…" : "Test"}
          </Button>
          {/* OAuth-managed servers have their URL/auth wired from the
              connection — editing them by hand would only desync the
              pairing, so the Edit affordance is hidden for them. */}
          {!managedBy && (
            <Button size="md" variant="ghost" onClick={onEdit} disabled={isDeleting}>
              Edit
            </Button>
          )}
          <Button size="md" variant="ghost" onClick={onDelete} disabled={isDeleting}>
            {isDeleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-(--color-text-tertiary) truncate">
        {server.type === "stdio"
          ? `${server.command} ${(server.args ?? []).join(" ")}`
          : server.url}
      </p>
      <McpTestResult result={result} />
    </li>
  );
}
