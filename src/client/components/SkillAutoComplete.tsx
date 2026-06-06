// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener + DOM scrollIntoView (browser API subscriptions with cleanup)
import { useState, useEffect, useRef, useCallback } from "react";
import { LightningIcon, SparkleIcon } from "@phosphor-icons/react";
import { PopoverContent } from "./ui/popover.js";
import type { SkillInfo } from "../../server/shared/types.js";

/**
 * docs/178 — a ShipIt-native `/` command (e.g. `/compact`) surfaced in the same
 * menu as skills. Unlike skills, commands are ALWAYS `/`-prefixed (they're a
 * ShipIt construct, not a per-backend CLI skill whose token is `$` for Codex).
 */
export interface SlashCommand {
  name: string;
  description: string;
}

export interface SkillAutoCompleteProps {
  /** The current query text (after the leading `/`). */
  query: string;
  /** Available skills to search through. */
  skills: SkillInfo[];
  /** docs/178 — ShipIt-native `/` commands (always `/`-prefixed), listed first. */
  commands?: SlashCommand[];
  /**
   * Token prefix shown before each skill name — `/` for Claude, `$` for Codex.
   * The trigger char stays `/` for both backends; only the displayed/inserted
   * token differs. Defaults to `/`. See docs/138-skill-invocation §5.
   */
  tokenPrefix?: string;
  /** Called when the user selects a skill (passes the skill name). */
  onSelect: (skillName: string) => void;
  /** docs/178 — called when the user selects a ShipIt `/` command. */
  onCommandSelect?: (commandName: string) => void;
  /** Called when the autocomplete should be dismissed. */
  onDismiss: () => void;
}

/** A unified, keyboard-navigable menu row: either a ShipIt command or a skill. */
type MenuItem =
  | { kind: "command"; name: string; description: string }
  | { kind: "skill"; name: string; description?: string };

/** Filter skills by a query string (case-insensitive substring match on name). */
function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  if (!query) return skills.slice(0, 20);
  const lower = query.toLowerCase();
  return skills.filter((s) => s.name.toLowerCase().includes(lower)).slice(0, 20);
}

function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  const lower = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().includes(lower));
}

export function SkillAutoComplete({
  query,
  skills,
  commands = [],
  tokenPrefix = "/",
  onSelect,
  onCommandSelect,
  onDismiss,
}: SkillAutoCompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Commands first (they're ShipIt-native and few), then skills.
  const matches: MenuItem[] = [
    ...filterCommands(commands, query).map((c): MenuItem => ({ kind: "command", name: c.name, description: c.description })),
    ...filterSkills(skills, query).map((s): MenuItem => ({ kind: "skill", name: s.name, description: s.description })),
  ];

  const selectMatch = useCallback(
    (item: MenuItem) => {
      if (item.kind === "command") onCommandSelect?.(item.name);
      else onSelect(item.name);
    },
    [onCommandSelect, onSelect],
  );

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
          selectMatch(matches[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    },
    [matches, selectedIndex, selectMatch, onDismiss, scrollSelectedIntoView],
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
        No matching commands
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
      {matches.map((item, i) => (
        <button
          key={`${item.kind}:${item.name}`}
          className={`flex items-start gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors ${
            i === selectedIndex
              ? "bg-(--color-accent-subtle) text-(--color-text-link)"
              : "text-(--color-text-primary) hover:bg-(--color-bg-hover)"
          }`}
          onClick={() => selectMatch(item)}
          onMouseEnter={() => setSelectedIndex(i)}
          data-testid="skill-autocomplete-item"
        >
          {item.kind === "command" ? (
            <SparkleIcon size={14} className="shrink-0 mt-0.5 text-(--color-text-secondary)" />
          ) : (
            <LightningIcon size={14} className="shrink-0 mt-0.5 text-(--color-text-secondary)" />
          )}
          <span className="min-w-0">
            {/* Commands are always `/`-prefixed; skills use the backend token. */}
            <span className="font-medium">{item.kind === "command" ? "/" : tokenPrefix}{item.name}</span>
            {item.description && (
              <span className="block truncate text-(--color-text-tertiary)">{item.description}</span>
            )}
          </span>
        </button>
      ))}
    </PopoverContent>
  );
}
