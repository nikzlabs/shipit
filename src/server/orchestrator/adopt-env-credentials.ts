import {
  allServices,
  modeAllowsMultipleCredentials,
  modeCredentialFor,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import type { CredentialRoute } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import { envRouteIdFor } from "./service-routing.js";

function envDeliverableModes(): { serviceId: string; serviceName: string; billingMode: "sub" | "key"; storageEnv: string }[] {
  const out: { serviceId: string; serviceName: string; billingMode: "sub" | "key"; storageEnv: string }[] = [];
  for (const service of allServices()) {
    for (const mode of service.modes) {
      if (!modeCredentialFor(service.id, mode.kind, "string")) continue;
      const storageEnv = storageEnvFor(service.id, mode.kind);
      if (storageEnv) {
        out.push({ serviceId: service.id, serviceName: service.name, billingMode: mode.kind, storageEnv });
      }
    }
  }
  return out;
}

export interface EnvAdoptionResult {
  adopted: string[];
  rotated: string[];
  suppressed: string[];
  alreadyStored: string[];
}

/** Imports credentials and unsets user-removed variables so fallback readers cannot use them. */
export function adoptEnvCredentials(
  credentialStore: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): EnvAdoptionResult {
  const result: EnvAdoptionResult = { adopted: [], rotated: [], suppressed: [], alreadyStored: [] };

  for (const mode of envDeliverableModes()) {
    const value = env[mode.storageEnv]?.trim();
    const record = credentialStore.getAdoptedEnvCredential(mode.storageEnv);

    if (record?.removed) {
      if (value) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by a catalogue storageEnv name
        delete env[mode.storageEnv];
        result.suppressed.push(mode.storageEnv);
      }
      continue;
    }
    if (!value) continue;

    const routeId = envRouteIdFor(mode.storageEnv);
    const existing = credentialStore.getCredentialRoute(routeId);

    if (!existing) {
      const group = credentialStore.listCredentialRoutes(mode.serviceId, mode.billingMode);
      if (!modeAllowsMultipleCredentials(mode.billingMode) && group.some((r) => r.via === "string")) {
        continue;
      }
      if (group.some((r) => r.via === "string" && credentialStore.getCredentialSecret(r.id) === value)) {
        result.alreadyStored.push(mode.storageEnv);
        continue;
      }
      const now = Date.now();
      const route: CredentialRoute = {
        id: routeId,
        serviceId: mode.serviceId,
        billingMode: mode.billingMode,
        via: "string",
        label: `${mode.serviceName} (${mode.storageEnv})`,
        labelIsGenerated: true,
        isPrimary: false,
        priority: group.reduce((max, r) => Math.max(max, r.priority ?? -1), -1) + 1,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      };
      // Record the import first: a row without provenance cannot rotate on later boots.
      credentialStore.setAdoptedEnvCredential(mode.storageEnv, { importedValue: value });
      credentialStore.upsertCredentialRouteWithSecret(route, value);
      result.adopted.push(mode.storageEnv);
      continue;
    }

    const stored = credentialStore.getCredentialSecret(routeId);
    const stillOurs = record !== undefined && stored === record.importedValue;
    if (stillOurs && existing.labelIsGenerated) {
      const twin = credentialStore
        .listCredentialRoutes(mode.serviceId, mode.billingMode)
        .find((r) => r.id !== routeId && r.via === "string"
          && credentialStore.getCredentialSecret(r.id) === stored);
      if (twin) {
        credentialStore.deleteCredentialRoute(routeId);
        result.alreadyStored.push(mode.storageEnv);
        continue;
      }
    }
    if (stillOurs && value !== stored) {
      // A failed secret write then stops future rotation rather than overwriting user changes.
      credentialStore.setAdoptedEnvCredential(mode.storageEnv, { importedValue: value });
      credentialStore.setCredentialSecret(routeId, value);
      result.rotated.push(mode.storageEnv);
    }
  }

  return result;
}
