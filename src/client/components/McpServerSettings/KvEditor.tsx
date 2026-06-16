import { Button } from "../ui/button.js";
import { inputClass } from "./shared.js";
import type { KvRow } from "./utils/payload.js";

/**
 * Key-value editor for a server's stdio env vars / http headers. Values are
 * raw secrets (password inputs); when editing, the value placeholder reads
 * "(unchanged)" because secrets are never echoed back from the server.
 */
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
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-(--color-text-secondary)">
        {type === "stdio" ? "Environment variables" : "Headers"} (stored as secrets)
      </span>
      {kv.map((row, idx) => (
        <div key={idx} className="flex gap-2 items-center">
          <input
            className={inputClass}
            value={row.key}
            placeholder={type === "stdio" ? "SENTRY_AUTH_TOKEN" : "Authorization"}
            onChange={(e) =>
              onChange(kv.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
            }
          />
          <input
            className={inputClass}
            type="password"
            value={row.value}
            placeholder={editingId ? "(unchanged)" : "value"}
            onChange={(e) =>
              onChange(kv.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
            }
          />
          <Button
            size="md"
            variant="ghost"
            onClick={() => onChange(kv.filter((_, i) => i !== idx))}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        size="md"
        variant="secondary"
        onClick={() => onChange([...kv, { key: "", value: "" }])}
      >
        + Add {type === "stdio" ? "variable" : "header"}
      </Button>
    </div>
  );
}
