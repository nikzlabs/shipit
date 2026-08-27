/**
 * Which kind of host ShipIt is installed on (docs/284).
 *
 * NOT the same thing as `RUNTIME_MODE`. That says whether sessions get Docker
 * containers at all (`local` is the dogfood inner instance, which skips Docker
 * entirely). This says who else is using the machine:
 *
 *  - **`server`** (default) — a host provisioned for ShipIt, as
 *    `deployment/vps` sets up. Nothing else needs the RAM, so ShipIt may fill
 *    it up to the usual host safety margin.
 *  - **`local`** — the machine the user is also working on, as
 *    `deployment/local/setup.sh` sets up (it starts the stack from
 *    `docker/local/prod/compose.yml`, which sets this). Taking the whole
 *    machine there is wrong by default: ShipIt would push the user's own
 *    editor and browser into swap before it reclaimed anything.
 *
 * Defaulting to `server` keeps every existing deployment byte-for-byte
 * unchanged; only an installer that opts in gets the smaller default.
 */

export type DeploymentMode = "local" | "server";

/**
 * Read the deployment mode from the environment. Anything other than an exact
 * `local` is `server` — an unrecognised value must not silently halve a
 * server's budget.
 */
export function resolveDeploymentMode(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentMode {
  return env.SHIPIT_DEPLOYMENT?.trim().toLowerCase() === "local" ? "local" : "server";
}
