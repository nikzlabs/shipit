/**
 * The environment a plugin container needs **because it borrows the
 * session-worker image**.
 *
 * `createContainer.Env` does not replace the image's own `ENV`, it MERGES over
 * it — and the API offers no way to unset an inherited variable, only to give it
 * a different value. Both plugin containers (`plugin-install.ts`,
 * `plugin-cli-run.ts`) run that image as a **per-session uid** (docs/270) with
 * its entrypoint bypassed, so every path the image bakes in for the *worker*
 * arrives here naming a tree that uid cannot write:
 *
 *  - `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers` — created by root and
 *    closed with `chmod -R a+rX`, so read and traverse only. `playwright-core`
 *    creates its registry-wide lock directory `__dirlock` in there *before* any
 *    download starts, so a plugin whose `install:` runs `playwright install`
 *    died at `EACCES: permission denied, mkdir '/opt/playwright-browsers/__dirlock'`
 *    — observed in production on 2026-09-03 across three sessions. That failure
 *    is why this module exists.
 *  - `NPM_CONFIG_PREFIX=/home/shipit/.npm-global` — owned by uid 1000, while the
 *    container runs as e.g. 2000765, so `npm i -g` fails the same way.
 *  - `HOME` / `AGENT_HOME=/home/shipit` — the same tree, the same mismatch.
 *
 * **Overriding is the fix; omitting is what produced the bug.** The install
 * container's `Env` used to be described as "the generation's env and nothing
 * else", which was true of this *process's* environment and never true of the
 * *image's*.
 *
 * Where the overrides point matters as much as that they are writable:
 *
 *  - `/tmp` is a 512 MB tmpfs discarded when the container exits. Right for
 *    `HOME`, which is per-run scratch by design; wrong for a browser, which is
 *    hundreds of megabytes and has to outlive the install that fetched it.
 *  - `CONTAINER_PLUGIN_DIR` is the generation's overlay. What install writes
 *    lands in the upper layer, survives publish, and is mounted at the SAME path
 *    in the plugin's CLI container — so a toolchain fetched at install time is
 *    still there, under the same name, at run time. That is the whole reason
 *    both surfaces build their environment from this one function instead of
 *    each spelling it out.
 *
 * **Plugin *service* containers deliberately do not use this.** They run the
 * image the plugin author declared (`plugin-compose.ts` requires an `image:`),
 * so nothing is inherited from the session-worker image and there is nothing to
 * repair — while forcing `PLAYWRIGHT_BROWSERS_PATH` onto, say, an official
 * Playwright image would point it away from the browsers that image ships. A
 * service that wants the install-time toolchain names it in its own fragment.
 *
 * Audited and deliberately NOT overridden:
 *
 *  - `JAVA_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, and the Gradle / agent-CLI
 *    `PATH` entries — read-only toolchains, correct as inherited. A plugin that
 *    needs to *add* an SDK component still cannot, which is a real limit of
 *    borrowing the image rather than this bug; relocating a multi-gigabyte SDK
 *    would cost far more than it buys.
 *  - `GRADLE_USER_HOME` is not baked at all — Gradle derives it from `HOME`,
 *    which is `/tmp` here: writable, and ephemeral like any other build cache a
 *    plugin did not declare a dep dir for.
 *  - `NODE_ENV=production`. Not a path, so it EACCESes nothing, but it is
 *    inherited the same way and it is not inert: npm's `omit` defaults to `dev`
 *    when it is set, so a plugin whose `install:` is `npm ci && npm run build`
 *    gets no devDependencies. Left alone because every replacement value is a
 *    behaviour change for plugin code that reads it at *run* time, and because
 *    the failure it causes is loud and self-describing rather than silent.
 */

import type Docker from "dockerode";
import { CONTAINER_PLUGIN_DIR } from "../shared/plugin-contract.js";

/**
 * Root of the writable toolchain tree, inside the generation's overlay so that
 * whatever install puts there is still mounted at the same path when the
 * plugin's own code runs.
 *
 * Dot-prefixed and namespaced: it sits at the plugin repository's root, beside
 * the author's own files, and must not collide with one of them.
 */
export const CONTAINER_PLUGIN_TOOLCHAIN_DIR = `${CONTAINER_PLUGIN_DIR}/.shipit-toolchain`;

/** Replaces the image's root-owned `PLAYWRIGHT_BROWSERS_PATH`. */
export const PLUGIN_BROWSERS_DIR = `${CONTAINER_PLUGIN_TOOLCHAIN_DIR}/playwright-browsers`;

/** Replaces the image's uid-1000-owned `NPM_CONFIG_PREFIX`. */
export const PLUGIN_NPM_PREFIX_DIR = `${CONTAINER_PLUGIN_TOOLCHAIN_DIR}/npm-global`;

/**
 * The directories the overrides name, for the install container to create up
 * front. A tool that assumes its own root already exists — rather than
 * `mkdir -p`-ing it — would otherwise fail on a path ShipIt chose for it, which
 * is a worse failure than the one being fixed because nothing names ShipIt.
 */
export const PLUGIN_TOOLCHAIN_DIRS: readonly string[] = [
  PLUGIN_BROWSERS_DIR,
  PLUGIN_NPM_PREFIX_DIR,
];

/**
 * The overrides both plugin container surfaces set, in one list.
 *
 * Async only because `PATH` cannot be composed without the image's own value:
 * `Env` entries are literals, so there is no `$PATH` to expand, and the
 * alternative — restating the image's `PATH` as a constant here — goes stale
 * silently the first time the Dockerfile adds a toolchain. The inspect is a
 * local daemon call beside the several each container creation already makes,
 * so it is not cached: a cache would hold a stale `PATH` across an image
 * rebuild, and a cached failure would disable the override for the life of the
 * process.
 *
 * A daemon that cannot answer degrades to no `PATH` override rather than
 * failing the run: a globally installed binary is then reachable at
 * `$NPM_CONFIG_PREFIX/bin` and not by bare name, which is a smaller loss than
 * refusing every plugin install over one inspect.
 */
export async function pluginContainerEnv(docker: Docker, image: string): Promise<string[]> {
  const env = [
    "HOME=/tmp",
    "AGENT_HOME=/tmp",
    "npm_config_update_notifier=false",
    `PLAYWRIGHT_BROWSERS_PATH=${PLUGIN_BROWSERS_DIR}`,
    `NPM_CONFIG_PREFIX=${PLUGIN_NPM_PREFIX_DIR}`,
  ];
  const inherited = await imagePath(docker, image);
  if (inherited) env.push(`PATH=${PLUGIN_NPM_PREFIX_DIR}/bin:${inherited}`);
  return env;
}

/** The image's own `PATH`, or `null` when the daemon cannot say. */
async function imagePath(docker: Docker, image: string): Promise<string | null> {
  try {
    const info = await docker.getImage(image).inspect();
    const entry = (info.Config?.Env ?? []).find((e) => e.startsWith("PATH="));
    return entry ? entry.slice("PATH=".length) : null;
  } catch {
    return null;
  }
}
