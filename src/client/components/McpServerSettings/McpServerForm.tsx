import { Button } from "../ui/button.js";
import { bindSetting, settingCopy } from "../Settings/setting-binding.js";
import { inputClass } from "./shared.js";
import { McpTypeSelector } from "./McpTypeSelector.js";
import { KvEditor } from "./KvEditor.js";
import type { FormState } from "./utils/payload.js";

/**
 * The MCP form is bespoke — no standard control carries a transport that
 * repaints half the fields — but **every box binds to its own declaration**
 * (docs/299-agent-settings-access, plan.md → Bespoke panels declare per field).
 * One binding for the panel would let a field be added, bound to it, and shipped
 * with no description, no projection rule and no refusal reason.
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
        <span className="text-xs text-(--color-text-secondary)">
          {settingCopy("mcp.servers[].name").label}
        </span>
        <input
          className={inputClass}
          value={form.name}
          placeholder="sentry"
          onChange={(e) => onUpdate({ name: e.target.value })}
          {...bindSetting("mcp.servers[].name")}
        />
      </label>

      <McpTypeSelector value={form.type} onChange={(type) => onUpdate({ type })} />

      {form.type === "stdio" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">
              {settingCopy("mcp.servers[].command").label}
            </span>
            <input
              className={inputClass}
              value={form.command}
              placeholder="npx"
              onChange={(e) => onUpdate({ command: e.target.value })}
              {...bindSetting("mcp.servers[].command")}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">
              {settingCopy("mcp.servers[].args").label} (space-separated)
            </span>
            <input
              className={inputClass}
              value={form.args}
              placeholder="-y @sentry/mcp-server"
              onChange={(e) => onUpdate({ args: e.target.value })}
              {...bindSetting("mcp.servers[].args")}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">
              {settingCopy("mcp.servers[].npmPackage").label} (optional — installed at session start)
            </span>
            <input
              className={inputClass}
              value={form.npmPackage}
              placeholder="@sentry/mcp-server"
              onChange={(e) => onUpdate({ npmPackage: e.target.value })}
              {...bindSetting("mcp.servers[].npmPackage")}
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-(--color-text-secondary)">
            {settingCopy("mcp.servers[].url").label}
          </span>
          <input
            className={inputClass}
            value={form.url}
            placeholder="https://mcp.sentry.dev/mcp"
            onChange={(e) => onUpdate({ url: e.target.value })}
            {...bindSetting("mcp.servers[].url")}
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
        {/* Save writes the whole entry, which is the collection's add/update
            operation — plan.md → The unit of a change is the declared operation. */}
        <Button
          size="md"
          variant="primary"
          onClick={onSave}
          disabled={saving}
          aria-label="Save MCP server"
          {...bindSetting("mcp.servers")}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="md" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
