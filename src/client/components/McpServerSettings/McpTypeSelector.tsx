import { inputClass } from "./shared.js";

/** stdio vs http selector for the MCP server form. */
export function McpTypeSelector({
  value,
  onChange,
}: {
  value: "stdio" | "http";
  onChange: (type: "stdio" | "http") => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-(--color-text-secondary)">Type</span>
      <select
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value as "stdio" | "http")}
      >
        <option value="stdio">stdio (spawned process)</option>
        <option value="http">http (remote endpoint)</option>
      </select>
    </label>
  );
}
