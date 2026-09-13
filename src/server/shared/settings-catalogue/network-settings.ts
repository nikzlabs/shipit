import { defineSetting, derived, itemAddress, userText } from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { collection, text } from "./value-types.js";

/**
 * The **Network** tab's allowlist (docs/299-agent-settings-access, plan.md →
 * Scope inventory). The containment toggle beside it is a single stored value
 * and is declared with the global scalars.
 *
 * Only the global list is here. A single session's hosts come from that
 * session's own egress prompt card and its session dialog, which req 5 does not
 * name — `exclusions.ts` records that.
 */

const HOST_ADDRESS = itemAddress("a host in the global allowlist");

export const NETWORK_SETTINGS = {
  "network.egress.hosts": defineSetting({
    key: "network.egress.hosts",
    tab: "network",
    scope: "global",
    label: "Allowlist",
    description:
      "Hosts a contained session may reach. The shipped defaults are part of the list and can be "
      + "removed or restored. A leading dot matches subdomains too. Changes apply the next time "
      + "each session's container starts.",
    type: collection<string>({
      operations: ["add", "remove", "restore-defaults"],
      patchableFields: [],
    }),
    store: { kind: "bespoke", ownedBy: "the egress allowlist store, global scope (/api/egress/hosts)" },
    emits: derived("the allowed hosts", (raw) =>
      Array.isArray(raw) ? raw.filter((host): host is string => typeof host === "string") : []),
    propose: { kind: "yes" },
  }),

  "network.egress.hosts[].host": defineSetting({
    key: "network.egress.hosts[].host",
    tab: "network",
    scope: "global",
    address: HOST_ADDRESS,
    label: "Host",
    description:
      "One entry of the allowlist — `api.example.com`, or `.example.com` to match subdomains as "
      + "well.",
    type: text({ maxLength: 253, noun: "Host", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "the egress allowlist store, global scope (/api/egress/hosts)" },
    emits: userText(
      "A host name the user allowed. It is the whole subject of the setting, and a proposal card "
      + "shows it in full — there is nothing else of it to withhold.",
    ),
    propose: { kind: "yes" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
