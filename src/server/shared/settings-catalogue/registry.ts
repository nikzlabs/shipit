import { BROWSER_SETTINGS } from "./browser-settings.js";
import { GLOBAL_SETTINGS } from "./global-settings.js";
import { INTEGRATIONS_SETTINGS } from "./integrations-settings.js";
import { NETWORK_SETTINGS } from "./network-settings.js";
import { PROJECT_SETTINGS } from "./project-settings.js";
import { ROLES_SETTINGS } from "./roles-settings.js";
import { SERVICES_SETTINGS } from "./services-settings.js";
import { VOICE_SETTINGS } from "./voice-settings.js";
import type { AnySettingDeclaration } from "./types.js";

/**
 * Every setting either settings dialog shows (docs/299-agent-settings-access
 * req 5), from the declarations and nothing else. A setting reaches the agent by
 * being declared, so there is no second registration to forget (req 7) — and a
 * source added here without being declared has nothing to add.
 *
 * The sources are separate files because the panels are: the global scalars
 * derive the settings payload, while a bespoke panel's fields are declared for
 * discovery and written by the panel that owns them.
 */
const SOURCES: readonly Record<string, AnySettingDeclaration>[] = [
  GLOBAL_SETTINGS,
  SERVICES_SETTINGS,
  ROLES_SETTINGS,
  INTEGRATIONS_SETTINGS,
  NETWORK_SETTINGS,
  VOICE_SETTINGS,
  PROJECT_SETTINGS,
  BROWSER_SETTINGS,
];

export const ALL_SETTINGS: readonly AnySettingDeclaration[] = SOURCES.flatMap(
  (source) => Object.values(source),
);

/**
 * Every declared key, as a type.
 *
 * It is what makes "a field with no declaration has nothing to bind to"
 * (plan.md → Bespoke panels declare per field) a compile error rather than a
 * runtime one: a dialog control binds by naming a `SettingKey`, so a control
 * nobody declared cannot name anything.
 */
export type SettingKey =
  | keyof typeof GLOBAL_SETTINGS
  | keyof typeof SERVICES_SETTINGS
  | keyof typeof ROLES_SETTINGS
  | keyof typeof INTEGRATIONS_SETTINGS
  | keyof typeof NETWORK_SETTINGS
  | keyof typeof VOICE_SETTINGS
  | keyof typeof PROJECT_SETTINGS
  | keyof typeof BROWSER_SETTINGS;

const BY_KEY = new Map(ALL_SETTINGS.map((declaration) => [declaration.key, declaration]));

export function findSetting(key: string): AnySettingDeclaration | undefined {
  return BY_KEY.get(key);
}

/** The declaration a field key belongs to: `mcp.servers[].url` → `mcp.servers`. */
export function collectionKeyOf(key: string): string | undefined {
  const at = key.indexOf("[]");
  return at === -1 ? undefined : key.slice(0, at);
}
