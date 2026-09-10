import type { DeclaredSecretState } from "../stores/preview-store.js";

const PLATFORM_SOURCE_LABELS: Record<string, string> = {
  "platform:claude_oauth": "Claude OAuth",
  "platform:github_token": "GitHub token",
};

export function isPlatformProvided(requirement: DeclaredSecretState): boolean {
  return (
    !!requirement.source?.startsWith("platform:") && (requirement.plugins ?? []).length === 0
  );
}

export interface DeclaredSecretRowProps {
  requirement: DeclaredSecretState;
  value: string;
  /** A value is stored but never sent to the browser; blank input keeps it. */
  isSet: boolean;
  missing: Record<string, string[]>;
  onChange: (v: string) => void;
  onClear: () => void;
}

export function DeclaredSecretRow({
  requirement,
  value,
  isSet,
  missing,
  onChange,
  onClear,
}: DeclaredSecretRowProps) {
  const isPlatform = isPlatformProvided(requirement);
  const platformLabel = requirement.source ? PLATFORM_SOURCE_LABELS[requirement.source] : null;
  const isMissing =
    requirement.required &&
    requirement.services.some((svc) => (missing[svc] ?? []).includes(requirement.name));

  return (
    <div
      className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary)/50 p-3 space-y-2"
      data-testid={`secret-declared-${requirement.name}`}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <code className="font-mono text-sm text-(--color-text-primary) break-all">
          {requirement.name}
        </code>
        {requirement.required && (
          <span
            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
              isMissing
                ? "bg-(--color-warning)/20 text-(--color-warning)"
                : "bg-(--color-bg-hover) text-(--color-text-secondary)"
            }`}
            data-testid={`secret-required-${requirement.name}`}
          >
            Required
          </span>
        )}
        {requirement.agent && (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-accent)/15 text-(--color-accent)"
            title="Also injected into the agent container"
            data-testid={`secret-agent-${requirement.name}`}
          >
            Agent
          </span>
        )}
        {isPlatform && (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-bg-hover) text-(--color-text-secondary)"
            title={`Resolved from ${platformLabel ?? requirement.source}`}
            data-testid={`secret-platform-${requirement.name}`}
          >
            Platform
          </span>
        )}
      </div>

      {requirement.description && (
        <p className="text-xs text-(--color-text-secondary)">{requirement.description}</p>
      )}

      <div className="flex items-center gap-2 text-[11px] text-(--color-text-tertiary) flex-wrap">
        <span>Used by:</span>
        {requirement.services.map((svc) => (
          <span
            key={svc}
            className="px-1.5 py-0.5 rounded bg-(--color-bg-hover) text-(--color-text-secondary)"
          >
            {svc}
          </span>
        ))}
        {(requirement.plugins ?? []).map((alias) => (
          <span
            key={`plugin:${alias}`}
            title={`Declared by the ${alias} plugin`}
            className="px-1.5 py-0.5 rounded bg-(--color-accent)/15 text-(--color-accent)"
            data-testid={`secret-plugin-claimant-${requirement.name}-${alias}`}
          >
            {alias}
          </span>
        ))}
        {requirement.services.length === 0 && (requirement.plugins ?? []).length === 0 && (
          <span className="italic">nothing yet</span>
        )}
      </div>

      {isPlatform ? (
        <div className="text-xs text-(--color-text-tertiary) italic">
          {platformLabel
            ? `Provided automatically from your ${platformLabel}.`
            : `Provided automatically (${requirement.source}).`}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              isSet
                ? "•••••••• saved — type to replace"
                : requirement.required || requirement.pluginRequired
                  ? "Required — set a value"
                  : "value (optional)"
            }
            className="flex-1 rounded-md bg-(--color-bg-primary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
            data-testid={`secret-value-${requirement.name}`}
          />
          {isSet && value.length === 0 && (
            <button
              onClick={onClear}
              className="text-xs text-(--color-text-tertiary) hover:text-(--color-error) transition-colors shrink-0"
              data-testid={`secret-clear-${requirement.name}`}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
