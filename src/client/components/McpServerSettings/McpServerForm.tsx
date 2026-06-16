import { Button } from "../ui/button.js";
import { inputClass } from "./shared.js";
import { McpTypeSelector } from "./McpTypeSelector.js";
import { KvEditor } from "./KvEditor.js";
import type { FormState } from "./utils/payload.js";

/**
 * Add/edit form for a single MCP server. Switches between stdio (command /
 * args / npm package) and http (URL) fields, and embeds the env/header
 * key-value editor. Purely controlled — all state lives in `useMcpFormState`.
 */
export function McpServerForm({
  form,
  formError,
  saving,
  onUpdate,
  onSave,
  onCancel,
}: {
  form: FormState;
  formError: string | null;
  saving: boolean;
  onUpdate: (patch: Partial<FormState>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex flex-col gap-3"
      data-testid="mcp-server-form"
    >
      <h4 className="text-sm font-medium text-(--color-text-primary)">
        {form.editingId ? `Edit "${form.editingId}"` : "Add MCP Server"}
      </h4>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-(--color-text-secondary)">Name</span>
        <input
          className={inputClass}
          value={form.name}
          placeholder="sentry"
          onChange={(e) => onUpdate({ name: e.target.value })}
        />
      </label>

      <McpTypeSelector value={form.type} onChange={(type) => onUpdate({ type })} />

      {form.type === "stdio" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">Command</span>
            <input
              className={inputClass}
              value={form.command}
              placeholder="npx"
              onChange={(e) => onUpdate({ command: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">
              Arguments (space-separated)
            </span>
            <input
              className={inputClass}
              value={form.args}
              placeholder="-y @sentry/mcp-server"
              onChange={(e) => onUpdate({ args: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">
              npm package (optional — installed at session start)
            </span>
            <input
              className={inputClass}
              value={form.npmPackage}
              placeholder="@sentry/mcp-server"
              onChange={(e) => onUpdate({ npmPackage: e.target.value })}
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-(--color-text-secondary)">URL</span>
          <input
            className={inputClass}
            value={form.url}
            placeholder="https://mcp.sentry.dev/mcp"
            onChange={(e) => onUpdate({ url: e.target.value })}
          />
        </label>
      )}

      <KvEditor
        type={form.type}
        editingId={form.editingId}
        kv={form.kv}
        onChange={(kv) => onUpdate({ kv })}
      />

      {formError && <p className="text-xs text-(--color-error)">{formError}</p>}

      <div className="flex gap-2">
        <Button size="md" variant="primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="md" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
