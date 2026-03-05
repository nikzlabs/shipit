import type { PermissionMode } from "../../server/shared/types.js";

const MODES: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: "auto", label: "Auto", description: "All changes applied immediately" },
  { value: "plan", label: "Plan", description: "Read-only — Claude will explore and plan without making changes" },
  { value: "normal", label: "Normal", description: "Supervised — Claude will ask before each change" },
];

export function ModeSelector({
  mode,
  onChange,
  disabled,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1" data-testid="mode-selector">
      {MODES.map((m) => (
        <button
          key={m.value}
          onClick={() => onChange(m.value)}
          disabled={disabled}
          title={m.description}
          className={`px-2 py-0.5 text-xs rounded-full transition-colors font-medium ${
            mode === m.value
              ? m.value === "plan"
                ? "bg-(--color-accent) text-(--color-accent-text)"
                : m.value === "normal"
                  ? "bg-(--color-warning) text-(--color-accent-text)"
                  : "bg-(--color-text-tertiary) text-(--color-accent-text)"
              : "bg-(--color-bg-secondary) text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
          aria-pressed={mode === m.value}
          data-testid={`mode-${m.value}`}
        >
          {m.label}
        </button>
      ))}
      {mode === "plan" && (
        <span className="text-xs text-(--color-accent) ml-1" data-testid="mode-badge">
          Read-only
        </span>
      )}
      {mode === "normal" && (
        <span className="text-xs text-(--color-warning) ml-1" data-testid="mode-badge">
          Supervised
        </span>
      )}
    </div>
  );
}
