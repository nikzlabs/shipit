import { useState } from "react";

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "fullstack" | "backend" | "utility";
  icon: string;
}

const CATEGORY_LABELS: Record<TemplateInfo["category"], string> = {
  frontend: "Frontend",
  fullstack: "Full-Stack",
  backend: "Backend",
  utility: "Utility",
};

const CATEGORY_ORDER: TemplateInfo["category"][] = [
  "frontend",
  "fullstack",
  "backend",
  "utility",
];

const ICON_MAP: Record<string, string> = {
  react: "\u269B\uFE0F",
  vue: "\uD83D\uDC9A",
  svelte: "\uD83D\uDD25",
  vanilla: "\uD83D\uDFE1",
  html: "\uD83D\uDCC4",
  nextjs: "\u25B2",
  astro: "\uD83D\uDE80",
  express: "\uD83D\uDFE2",
  hono: "\uD83D\uDD36",
  fastify: "\u26A1",
  node: "\uD83D\uDCBB",
};

function TemplateCard({
  template,
  onSelect,
  disabled,
}: {
  template: TemplateInfo;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(template.id)}
      disabled={disabled}
      className="flex items-start gap-3 p-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:border-gray-400 dark:hover:border-gray-600 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span className="text-xl shrink-0 mt-0.5" role="img" aria-label={template.icon}>
        {ICON_MAP[template.icon] ?? "\uD83D\uDCE6"}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{template.name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{template.description}</p>
      </div>
    </button>
  );
}

export function TemplateSelector({
  templates,
  onSelect,
  onDismiss,
  applying,
}: {
  templates: TemplateInfo[];
  onSelect: (templateId: string) => void;
  onDismiss: () => void;
  applying: boolean;
}) {
  const [filter, setFilter] = useState<TemplateInfo["category"] | "all">("all");

  const filtered =
    filter === "all"
      ? templates
      : templates.filter((t) => t.category === filter);

  // Group filtered templates by category (preserving CATEGORY_ORDER)
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    items: filtered.filter((t) => t.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Start with a template
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Choose a project template, or just start chatting to build from scratch.
          </p>
        </div>

        {/* Category filter pills */}
        <div className="flex items-center justify-center gap-2 mb-6 flex-wrap">
          {(["all", ...CATEGORY_ORDER] as const).map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${
                filter === cat
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {cat === "all" ? "All" : CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>

        {/* Applying state */}
        {applying && (
          <div className="text-center py-8">
            <div className="inline-flex items-center gap-2 text-sm text-blue-400">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Setting up project...
            </div>
          </div>
        )}

        {/* Template grid */}
        {!applying && (
          <div className="space-y-5">
            {grouped.map((group) => (
              <div key={group.category}>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 px-1">
                  {group.label}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {group.items.map((template) => (
                    <TemplateCard
                      key={template.id}
                      template={template}
                      onSelect={onSelect}
                      disabled={applying}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Skip button */}
        {!applying && (
          <div className="text-center mt-8">
            <button
              onClick={onDismiss}
              className="px-5 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
            >
              Skip — start with an empty project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
