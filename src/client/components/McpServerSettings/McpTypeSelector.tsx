import { bindSetting, settingCopy, settingOptions } from "../Settings/setting-binding.js";
import { inputClass } from "./shared.js";

export function McpTypeSelector({
  value,
  onChange,
}: {
  value: "stdio" | "http";
  onChange: (type: "stdio" | "http") => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-(--color-text-secondary)">
        {settingCopy("mcp.servers[].type").label}
      </span>
      <select
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value as "stdio" | "http")}
        {...bindSetting("mcp.servers[].type")}
      >
        {settingOptions("mcp.servers[].type").map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
