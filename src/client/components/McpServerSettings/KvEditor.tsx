import { Button } from "../ui/button.js";
import { bindSetting, settingCopy } from "../Settings/setting-binding.js";
import { inputClass } from "./shared.js";
import type { KvRow } from "./utils/payload.js";

export function KvEditor({
  type,
  editingId,
  kv,
  onChange,
}: {
  type: "stdio" | "http";
  editingId: string;
  kv: KvRow[];
  onChange: (kv: KvRow[]) => void;
}) {
  // One editor, two settings: a stdio server's environment and an HTTP
  // server's headers are separate declarations with separate refusals.
  const settingKey = type === "stdio" ? "mcp.servers[].env" : "mcp.servers[].headers";
  const { label } = settingCopy(settingKey);
  const noun = type === "stdio" ? "variable" : "header";
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-(--color-text-secondary)">{label} (stored as secrets)</span>
      {kv.map((row, idx) => (
        <div key={idx} className="flex gap-2 items-center">
          <input
            className={inputClass}
            value={row.key}
            placeholder={type === "stdio" ? "SENTRY_AUTH_TOKEN" : "Authorization"}
            aria-label={`${label} — name ${idx + 1}`}
            onChange={(e) =>
              onChange(kv.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
            }
            {...bindSetting(settingKey)}
          />
          <input
            className={inputClass}
            type="password"
            value={row.value}
            placeholder={
              editingId && row.originalKey === row.key.trim() ? "(unchanged)" : "value"
            }
            aria-label={`${label} — value ${idx + 1}`}
            onChange={(e) =>
              onChange(kv.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
            }
            {...bindSetting(settingKey)}
          />
          <Button
            size="md"
            variant="ghost"
            onClick={() => onChange(kv.filter((_, i) => i !== idx))}
            aria-label={`Remove ${noun} ${idx + 1}`}
            {...bindSetting(settingKey)}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        size="md"
        variant="secondary"
        onClick={() => onChange([...kv, { key: "", value: "" }])}
        {...bindSetting(settingKey)}
      >
        + Add {noun}
      </Button>
    </div>
  );
}
