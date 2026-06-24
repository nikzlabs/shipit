/**
 * SourceToggle — a small segmented "Rendered / Source" control for HTML/SVG.
 * Lives in each surface's own header (the dialog header, the Present carousel
 * header) so `FileContentView` stays a pure renderer with no chrome of its own
 * (docs/219). The surface owns the `viewMode` state and passes it down.
 */

export type ViewMode = "rendered" | "source";

export function SourceToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-(--color-border-secondary) p-0.5 text-xs"
      role="group"
      aria-label="View mode"
    >
      {(["rendered", "source"] as const).map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(mode)}
            className={`px-2 py-0.5 rounded transition-colors cursor-pointer capitalize ${
              active
                ? "bg-(--color-bg-hover) text-(--color-text-primary)"
                : "text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
            }`}
          >
            {mode}
          </button>
        );
      })}
    </div>
  );
}
