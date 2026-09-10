import type { AgentId } from "../shared/types.js";
import type {
  AccountSelection,
  AccountSelectionFailure,
  ProviderRoute,
} from "./provider-account-manager.js";

const PROVIDER_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok Build",
};

export class ProviderRouteUnavailableError extends Error {
  readonly provider: AgentId;
  readonly failure: AccountSelectionFailure;

  constructor(provider: AgentId, failure: AccountSelectionFailure, subject?: string) {
    super(describeAccountSelectionFailure(provider, failure, subject));
    this.name = "ProviderRouteUnavailableError";
    this.provider = provider;
    this.failure = failure;
  }
}

// Let auth_required reach the guided sign-in path instead of throwing here.
export function isTurnBlockingFailure(failure: AccountSelectionFailure): boolean {
  return failure.reason === "all_exhausted";
}

export function describeAccountSelectionFailure(
  provider: AgentId,
  failure: AccountSelectionFailure,
  /** Service name when the credential belongs to a different vendor than the harness. */
  subject?: string,
): string {
  const label = subject ?? PROVIDER_LABEL[provider] ?? provider;
  switch (failure.reason) {
    case "all_exhausted": {
      const when = formatResetAt(failure.earliestResetAt);
      const resets = when
        ? `The earliest window resets at ${when}.`
        : `None of them reported when its window resets.`;
      if (subject) {
        return (
          `Every ${subject} credential is out of quota. ${resets} ` +
          `Send this message again once quota is back, or add another ${subject} credential in Settings → Services.`
        );
      }
      return (
        `Every connected ${label} account is out of quota. ${resets} ` +
        `Send this message again once quota is back, or connect another ${label} account in Settings.`
      );
    }
    case "auth_required":
      return subject
        ? `No ${subject} credential is configured. Add one in Settings → Services to run this turn.`
        : `No ${label} account is connected. Connect one in Settings to run this turn.`;
  }
}

export function routeFromSelection(
  provider: AgentId,
  selection: AccountSelection,
  subject?: string,
): ProviderRoute | undefined {
  if (selection.ok) return selection.route;
  if (isTurnBlockingFailure(selection)) {
    throw new ProviderRouteUnavailableError(provider, selection, subject);
  }
  return undefined;
}

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const parsed = new Date(resetAt);
  return Number.isNaN(parsed.getTime()) ? resetAt : parsed.toISOString();
}
