// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener + DOM scrollIntoView (browser API subscriptions with cleanup)
import { useState, useEffect, useRef, useCallback } from "react";
import { LightningIcon } from "@phosphor-icons/react";
import { PopoverContent } from "./ui/popover.js";
import type { SkillInfo } from "../../server/shared/types.js";

export interface SkillAutoCompleteProps {
  /** The current query text (after the leading `/`). */
  query: string;
  /** Available skills to search through. */
  skills: SkillInfo[];
  /** Called when the user selects a skill (passes the skill name). */
  onSelect: (skillName: string) => void;
  /** Called when the autocomplete should be dismissed. */
  onDismiss: () => void;
}

/** Filter skills by a query string (case-insensitive substring match on name). */
function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  if (!query) return skills.slice(0, 20);
  const lower = query.toLowerCase();
  return skills.filter((s) => s.name.toLowerCase().includes(lower)).slice(0, 20);
}

export function SkillAutoComplete({
  query,
  skills,
  onSelect,
  onDismiss,
}: SkillAutoCompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = filterSkills(skills, query);

  // Reset selected index when query changes (inline state reset during render)
  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    setSelectedIndex(0);
  }

  const scrollSelectedIntoView = useCallback((index: number) => {
    const el = listRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.min(prev + 1, matches.length - 1);
          scrollSelectedIntoView(next);
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          scrollSelectedIntoView(next);
          return next;
        });
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (matches.length > 0) {
          onSelect(matches[selectedIndex].name);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    },
    [matches, selectedIndex, onSelect, onDismiss, scrollSelectedIntoView],
  );

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (matches.length === 0) {
    return (
      <PopoverContent
        side="top"
        align="start"
        className="p-2 text-xs text-(--color-text-secondary)"
        style={{ width: "var(--radix-popover-trigger-width)" }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        data-testid="skill-autocomplete"
      >
        No matching skills
      </PopoverContent>
    );
  }

  return (
    <PopoverContent
      side="top"
      align="start"
      className="max-h-48 overflow-y-auto p-0"
      style={{ width: "var(--radix-popover-trigger-width)" }}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      data-testid="skill-autocomplete"
      ref={listRef}
    >
      {matches.map((skill, i) => (
        <button
          key={skill.name}
          className={`flex items-start gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors ${
            i === selectedIndex
              ? "bg-(--color-accent-subtle) text-(--color-text-link)"
              : "text-(--color-text-primary) hover:bg-(--color-bg-hover)"
          }`}
          onClick={() => onSelect(skill.name)}
          onMouseEnter={() => setSelectedIndex(i)}
          data-testid="skill-autocomplete-item"
        >
          <LightningIcon size={14} className="shrink-0 mt-0.5 text-(--color-text-secondary)" />
          <span className="min-w-0">
            <span className="font-medium">/{skill.name}</span>
            {skill.description && (
              <span className="block truncate text-(--color-text-tertiary)">{skill.description}</span>
            )}
          </span>
        </button>
      ))}
    </PopoverContent>
  );
}
