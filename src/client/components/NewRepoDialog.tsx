import { useState } from "react";
import type { TemplateInfo } from "./TemplateSelector.js";

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

export interface NewRepoDialogProps {
  username: string;
  templates: TemplateInfo[];
  onSubmit: (name: string, description: string, isPrivate: boolean, templateId: string) => void;
  onClose: () => void;
  creating: boolean;
}

export function NewRepoDialog({
  username,
  templates,
  onSubmit,
  onClose,
  creating,
}: NewRepoDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TemplateInfo["category"] | "all">("all");

  const trimmedName = name.trim();
  const isValidName = /^[a-zA-Z0-9._-]+$/.test(trimmedName);
  const canSubmit = trimmedName && isValidName && selectedTemplateId && !creating;

  const handleSubmit = () => {
    if (canSubmit && selectedTemplateId) {
      onSubmit(trimmedName, description.trim(), isPrivate, selectedTemplateId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  const filtered =
    filter === "all"
      ? templates
      : templates.filter((t) => t.category === filter);

  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    items: filtered.filter((t) => t.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="max-w-2xl w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Create New Repository
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-200 transition-colors text-xl leading-none"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Create a new repository under <span className="text-gray-800 dark:text-gray-200 font-medium">{username}</span> with a project template.
          </p>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
          {/* Repo name */}
          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
              Repository name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
              autoFocus
              disabled={creating}
            />
            {trimmedName && !isValidName && (
              <p className="text-xs text-red-400 mt-1">
                Only letters, numbers, hyphens, dots, and underscores allowed.
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short description of the project"
              className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              disabled={creating}
            />
          </div>

          {/* Visibility */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsPrivate(false)}
              disabled={creating}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                !isPrivate
                  ? "bg-gray-200 dark:bg-gray-700 border-blue-500 text-gray-900 dark:text-gray-100"
                  : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              Public
            </button>
            <button
              type="button"
              onClick={() => setIsPrivate(true)}
              disabled={creating}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                isPrivate
                  ? "bg-gray-200 dark:bg-gray-700 border-blue-500 text-gray-900 dark:text-gray-100"
                  : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              Private
            </button>
          </div>

          {/* Template selection */}
          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-2">
              Project template
            </label>

            {/* Category filter pills */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {(["all", ...CATEGORY_ORDER] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilter(cat)}
                  disabled={creating}
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

            {/* Template grid */}
            <div className="space-y-4">
              {grouped.map((group) => (
                <div key={group.category}>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 px-1">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {group.items.map((template) => (
                      <button
                        key={template.id}
                        onClick={() => setSelectedTemplateId(template.id)}
                        disabled={creating}
                        className={`flex items-start gap-3 p-3 rounded-lg border transition-colors text-left disabled:opacity-50 ${
                          selectedTemplateId === template.id
                            ? "border-blue-500 bg-blue-950/30"
                            : "border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:border-gray-400 dark:hover:border-gray-600"
                        }`}
                      >
                        <span className="text-xl shrink-0 mt-0.5" role="img" aria-label={template.icon}>
                          {ICON_MAP[template.icon] ?? "\uD83D\uDCE6"}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {template.name}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {template.description}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
          <button
            onClick={onClose}
            disabled={creating}
            className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? "Creating..." : "Create & Setup"}
          </button>
        </div>
      </div>
    </div>
  );
}
