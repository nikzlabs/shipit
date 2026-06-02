import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import type { TemplateInfo } from "../utils/template-info.js";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";

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
  streamlit: "\uD83C\uDF88",
  fastapi: "\uD83D\uDE84",
  gradio: "\uD83C\uDF9B\uFE0F",
  dash: "\uD83D\uDCC8",
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
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-(--color-border-secondary)">
          <div className="flex items-center justify-between mb-4">
            <DialogTitle className="text-lg font-semibold">
              Create New Repository
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-9 w-9 max-md:h-10 max-md:w-10"
              aria-label="Close"
            >
              <XIcon size={ICON_SIZE.MD} weight="bold" />
            </Button>
          </div>
          <p className="text-sm text-(--color-text-secondary)">
            Create a new repository under <span className="text-(--color-text-primary) font-medium">{username}</span> with a project template.
          </p>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
          {/* Repo name */}
          <div>
            <label className="block text-sm text-(--color-text-primary) mb-1">
              Repository name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-2.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
              autoFocus
              disabled={creating}
            />
            {trimmedName && !isValidName && (
              <p className="text-xs text-(--color-error) mt-1">
                Only letters, numbers, hyphens, dots, and underscores allowed.
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm text-(--color-text-primary) mb-1">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short description of the project"
              className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-2.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
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
                  ? "bg-(--color-bg-tertiary) border-(--color-accent) text-(--color-text-primary)"
                  : "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-secondary) hover:border-(--color-text-tertiary)"
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
                  ? "bg-(--color-bg-tertiary) border-(--color-accent) text-(--color-text-primary)"
                  : "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-secondary) hover:border-(--color-text-tertiary)"
              }`}
            >
              Private
            </button>
          </div>

          {/* Template selection */}
          <div>
            <label className="block text-sm text-(--color-text-primary) mb-2">
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
                      ? "bg-(--color-accent) text-(--color-accent-text)"
                      : "bg-(--color-bg-secondary) text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                  }`}
                >
                  {cat === "all" ? "All" : CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* Template grid */}
            <div className="space-y-4">
              {templates.length === 0 && (
                <p className="text-sm text-(--color-text-secondary) text-center py-6">Loading templates...</p>
              )}
              {grouped.map((group) => (
                <div key={group.category}>
                  <h3 className="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wider mb-2 px-1">
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
                            ? "border-(--color-accent) bg-(--color-accent-subtle)"
                            : "border-(--color-border-secondary) bg-(--color-bg-secondary) hover:bg-(--color-bg-hover) hover:border-(--color-text-tertiary)"
                        }`}
                      >
                        <span className="text-xl shrink-0 mt-0.5" role="img" aria-label={template.icon}>
                          {ICON_MAP[template.icon] ?? "\uD83D\uDCE6"}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-(--color-text-primary)">
                            {template.name}
                          </p>
                          <p className="text-xs text-(--color-text-secondary) mt-0.5">
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
        <div className="px-6 py-4 border-t border-(--color-border-secondary) flex gap-3">
          <Button
            variant="secondary"
            size="lg"
            onClick={onClose}
            disabled={creating}
            className="flex-1 rounded-lg py-2.5"
          >
            Cancel
          </Button>
          <Button
            size="lg"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 rounded-lg py-2.5"
          >
            {creating ? "Creating..." : "Create & Setup"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
