import type { AgentId } from "../agent-types.js";

export type ProviderRouteKind = "account" | "reserved";

export type ProviderAccountStatus = "ready" | "authenticating" | "auth_failed" | "unavailable";

export interface ProviderAccountCapabilities {
  models?: string[];
  supportsImages?: boolean;
  supportsReview?: boolean;
  supportedPermissionModes?: string[];
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}

export interface ProviderAccount {
  id: string;
  provider: AgentId;
  label: string;
  isPrimary: boolean;
  status: ProviderAccountStatus;
  plan?: string | null;
  capabilities?: ProviderAccountCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  createdAt: number;
  updatedAt: number;
}
