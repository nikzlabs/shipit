/**
 * docs/252 req 20 — **a deployment-supplied credential is an ordinary
 * credential.**
 *
 * Before this, a deployment's `ANTHROPIC_AUTH_TOKEN` produced no row at all:
 * `listCredentialRoutes` returns stored rows only, and `stringSelectionFor`
 * reached the variable solely as a last resort when nothing was stored
 * (`service-routing.ts`). It worked — turns authenticated with it — and it was
 * invisible in Settings, so it could not be renamed, reordered or removed. The
 * request that produced this requirement was exactly that asymmetry, seen in
 * the dogfood instance: *"I want these environment variables applied through
 * ShipIt to behave exactly as if I would add the service manually."*
 *
 * So at boot each catalogue `storageEnv` the environment holds becomes a stored
 * row, and from that moment nothing downstream treats it specially. It is also
 * what makes the dogfood instance representative of a real install rather than
 * a special case of one.
 *
 * Four things this has to get right, none of them visible in the happy path.
 *
 * **1. Rotation.** The stored copy is written once. A deployment that changes
 * the variable later would otherwise keep serving the value from first boot
 * forever — silently, since both look like a working credential. So adoption
 * re-reads on every boot and updates the secret of the row it created — unless
 * the user has replaced it by hand, which wins. "Is it still ours?" is answered
 * by remembering the exact value last imported, not by a flag: a flag says the
 * row *started* as ours, and the question is whether it still is.
 *
 * **2. Deletion is a deletion.** The variable is still set after the user
 * removes the row, so a naive adoption re-imports it on the next boot and the
 * removal never sticks. The removal is therefore remembered — and remembering
 * is not enough on its own, because `listConfiguredCredentials` and
 * `stringSelectionFor` read the raw variable too. Rather than teach each of
 * them about removals, adoption **unsets the variable in this process**: one
 * deletion at one point, and every downstream reader then sees the absence the
 * user asked for, with no new branch anywhere.
 *
 * A remembered removal is permanent for that variable, including across a
 * later rotation. "Re-import when the deployment changes the value" is
 * defensible and was rejected: the user's removal is an explicit act, and a
 * clause that resurrects a credential when something they cannot see changes is
 * not one they could predict. Re-adding it in Settings is one dialog.
 *
 * **3. The reserved route id.** `envRouteIdFor` maps the three legacy variables
 * to ids that pinned session rows already hold (`claude-env-oauth`,
 * `claude-api-key`, `codex-api-key`), so an adopted row must keep that id
 * rather than mint a `cred_…` one — otherwise every session pinned to it is
 * orphaned the moment adoption runs.
 *
 * **4. The same secret is one credential.** A row storing the variable's value
 * already exists whenever anything else put it there — the dogfood seeder POSTs
 * every `storageEnv` it finds, and a user can paste the key their deployment
 * also sets. Importing it again produced one token listed twice, offered to
 * itself as a failover target that can only fail with it. Adoption therefore
 * compares by VALUE (provenance is exactly what is missing) and both declines
 * to create a duplicate and withdraws one it created before this rule existed.
 */

import {
  allServices,
  modeAllowsMultipleCredentials,
  modeCredentialFor,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import type { CredentialRoute } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import { envRouteIdFor } from "./service-routing.js";

/** Every `(service, mode)` whose credential can arrive as a named variable. */
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
  /** Variables turned into a new stored row this boot. */
  adopted: string[];
  /** Variables whose adopted row had its secret refreshed from a changed value. */
  rotated: string[];
  /** Variables the user has removed, and which this boot therefore unset. */
  suppressed: string[];
  /**
   * Variables whose secret a stored credential already holds, so there was
   * nothing to adopt. Reported rather than silent: two rows for one token is
   * the bug this prevents, and a deployment that expects its variable to appear
   * needs to be able to see why it did not.
   */
  alreadyStored: string[];
}

/**
 * Bring the environment's credentials into the credential store, and take the
 * user's removals back out of the environment.
 *
 * @param env the process environment, **mutated** for a remembered removal —
 *   see point 2 in this module's docstring. Injectable so a test can assert the
 *   unset without touching `process.env`.
 */
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
      /**
       * **Adoption obeys the rule an add obeys**, which is the whole of req 20:
       * *"behave exactly as if I would add the service manually."*
       *
       * A `key` mode holds exactly one credential — req 12 says keys never fail
       * over, so a second is storage no routing rule can reach, and
       * `createStringCredential` answers a second one with a 409. Adopting past
       * that would put a card on screen holding two keys that the API forbids
       * and the router would never use, and the deployment's variable is
       * already shadowed by the stored credential today
       * (`collectServiceCredentialEnv` delivers the stored one). So the
       * variable stays exactly as unused as it is now — which is the honest
       * reading of "as if I added it manually", since adding it manually is
       * refused.
       */
      if (!modeAllowsMultipleCredentials(mode.billingMode) && group.some((r) => r.via === "string")) {
        continue;
      }
      /**
       * **The same secret is one credential, however it got here.**
       *
       * Adoption's job is to make an *unrepresented* environment credential
       * visible, not to add a second copy of one already on screen. Anything
       * that stores the variable's value through the ordinary API — the dogfood
       * seeder does exactly this (`scripts/seed-inner-credentials.ts` POSTs
       * every `storageEnv` it finds), and so does a user who pastes the key
       * their deployment also sets — leaves a row holding this very secret.
       * Importing it again produced two rows for one token, which is what the
       * dogfood instance showed: "Anthropic plan (dogfood secret)" and
       * "Anthropic (ANTHROPIC_AUTH_TOKEN)", one credential, listed twice, and
       * offered to each other as failover targets that can only fail together.
       *
       * Compared by value rather than by provenance because provenance is
       * exactly what is missing: a row the seeder created is indistinguishable
       * from one the user typed, and both are equally "already carrying this".
       *
       * Nothing is recorded when this fires. If the user later removes that
       * row, the variable is unrepresented again and the next boot adopts it —
       * which is right, and is the difference between skipping an import and
       * remembering a deletion.
       */
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
        // Named after where it came from, because that is the one thing the
        // user cannot otherwise tell about it — and renameable from the row's
        // `⋯` like any other, which is the point of adopting it at all.
        label: `${mode.serviceName} (${mode.storageEnv})`,
        labelIsGenerated: true,
        isPrimary: false,
        // Appended, never inserted: adopting a credential must not silently
        // change which one existing work runs on, exactly as adding one by hand
        // must not (docs/150 req 2).
        priority: group.reduce((max, r) => Math.max(max, r.priority ?? -1), -1) + 1,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      };
      /**
       * **Provenance first, then the row.** `CredentialStore.save()` logs and
       * swallows a write failure, so these two writes have a window between
       * them and the ORDER decides which way it fails. Provenance-then-row
       * fails to "a record of an import that did not happen": the next boot
       * sees no route, creates it, and rewrites the record — self-healing.
       * Row-then-provenance fails to an adopted row with no record, which reads
       * as "the user typed this" forever and silently stops the deployment ever
       * rotating it. Found by cross-backend review.
       */
      credentialStore.setAdoptedEnvCredential(mode.storageEnv, { importedValue: value });
      credentialStore.upsertCredentialRouteWithSecret(route, value);
      result.adopted.push(mode.storageEnv);
      continue;
    }

    // Rotation, and only over our own last import. A secret that no longer
    // matches it is one the user replaced by hand from the row's `⋯`, and the
    // deployment does not get to overwrite that on the next restart.
    const stored = credentialStore.getCredentialSecret(routeId);
    const stillOurs = record !== undefined && stored === record.importedValue;
    /**
     * **Withdraw a duplicate this function itself created.**
     *
     * The creation guard above stops a NEW duplicate; this clears one already
     * on disk, because the version without that guard shipped. An install whose
     * deployment sets a variable that some other row also stores — the dogfood
     * seeder is the reproducing case — came away with one token listed twice,
     * offered to itself as a failover target that can only fail with it.
     *
     * Deliberately narrow, because this deletes a credential: only a row
     * **adoption created** (it holds the reserved id), whose secret is **still
     * the one adoption imported** (so the user has not replaced it), and whose
     * label ShipIt still generated (so the user has not named it). Any of those
     * three failing means the row is the user's now, and a duplicate they can
     * see and remove beats one this deletes behind them.
     */
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
      // Same ordering rule as the initial import: a record naming a value the
      // row does not hold makes the next boot's `stillOurs` false, which
      // declines to rotate. Declining is the safe half — it never overwrites a
      // secret — and the user can replace it by hand.
      credentialStore.setAdoptedEnvCredential(mode.storageEnv, { importedValue: value });
      credentialStore.setCredentialSecret(routeId, value);
      result.rotated.push(mode.storageEnv);
    }
  }

  return result;
}
