import type { ReactNode } from "react";
import { Button } from "../ui/button.js";
import type { SettingKey } from "../../../server/shared/settings-catalogue/index.js";
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
 *
 * **And every box renders the declaration's DESCRIPTION, not only its label**
 * (req 7: the description the agent reads is the one the user reads). The
 * labels used to carry hand-written suffixes — "(space-separated)", "(optional —
 * installed at session start)" — which is a second authorship of exactly the
 * thing the declaration exists to hold; those sentences moved into the
 * declarations. The copy is marked with `data-setting-label` /
 * `data-setting-description`, so `settings-coverage.test.tsx` compares what is
 * on screen against the catalogue and a box that starts writing its own words
 * fails.
 */
function McpField({
  settingKey,
  children,
}: {
  settingKey: SettingKey;
  children: ReactNode;
}) {
  const { label, description } = settingCopy(settingKey);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-(--color-text-secondary)" data-setting-label={settingKey}>
        {label}
      </span>
      <span
        className="text-[11px] text-(--color-text-tertiary)"
        data-setting-description={settingKey}
      >
        {description}
      </span>
      {children}
    </label>
  );
}
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

      <McpField settingKey="mcp.servers[].name">
        <input
          className={inputClass}
          value={form.name}
          placeholder="sentry"
          onChange={(e) => onUpdate({ name: e.target.value })}
          {...bindSetting("mcp.servers[].name")}
        />
      </McpField>

      <McpTypeSelector value={form.type} onChange={(type) => onUpdate({ type })} />

      {form.type === "stdio" ? (
        <>
          <McpField settingKey="mcp.servers[].command">
            <input
              className={inputClass}
              value={form.command}
              placeholder="npx"
              onChange={(e) => onUpdate({ command: e.target.value })}
              {...bindSetting("mcp.servers[].command")}
            />
          </McpField>
          <McpField settingKey="mcp.servers[].args">
            <input
              className={inputClass}
              value={form.args}
              placeholder="-y @sentry/mcp-server"
              onChange={(e) => onUpdate({ args: e.target.value })}
              {...bindSetting("mcp.servers[].args")}
            />
          </McpField>
          <McpField settingKey="mcp.servers[].npmPackage">
            <input
              className={inputClass}
              value={form.npmPackage}
              placeholder="@sentry/mcp-server"
              onChange={(e) => onUpdate({ npmPackage: e.target.value })}
              {...bindSetting("mcp.servers[].npmPackage")}
            />
          </McpField>
        </>
      ) : (
        <McpField settingKey="mcp.servers[].url">
          <input
            className={inputClass}
            value={form.url}
            placeholder="https://mcp.sentry.dev/mcp"
            onChange={(e) => onUpdate({ url: e.target.value })}
            {...bindSetting("mcp.servers[].url")}
          />
        </McpField>
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
          aria-label={saving ? "Saving MCP server" : "Save MCP server"}
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
