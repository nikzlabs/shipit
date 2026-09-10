import path from "node:path";
import type Docker from "dockerode";
import { CONTAINER_PLUGIN_DIR } from "../shared/plugin-contract.js";

export const PLUGIN_TOOLCHAIN_DIR_NAME = ".shipit-toolchain";

// Persist install's tools in the generation overlay so later CLI containers can use them.
export const PLUGIN_TOOLCHAIN_DIR = path.posix.join(CONTAINER_PLUGIN_DIR, PLUGIN_TOOLCHAIN_DIR_NAME);
export const PLUGIN_BROWSERS_DIR = path.posix.join(PLUGIN_TOOLCHAIN_DIR, "playwright-browsers");
export const PLUGIN_NPM_PREFIX_DIR = path.posix.join(PLUGIN_TOOLCHAIN_DIR, "npm-global");

// Create even when unused: dep-base adoption requires a pointer for every declared directory.
export const PLUGIN_TOOLCHAIN_DIRS: readonly string[] = [
  PLUGIN_BROWSERS_DIR,
  PLUGIN_NPM_PREFIX_DIR,
];

// Docker merges image ENV. Override worker-owned paths that the session uid cannot write.
// Self imports disable toolchain overrides because /plugin is their actual git checkout.
export async function pluginContainerEnv(
  docker: Docker,
  image: string,
  opts: { toolchain: boolean },
): Promise<string[]> {
  const env = ["HOME=/tmp", "AGENT_HOME=/tmp", "npm_config_update_notifier=false"];
  if (!opts.toolchain) return env;
  env.push(
    `PLAYWRIGHT_BROWSERS_PATH=${PLUGIN_BROWSERS_DIR}`,
    `NPM_CONFIG_PREFIX=${PLUGIN_NPM_PREFIX_DIR}`,
  );
  const inherited = await imagePath(docker, image);
  if (inherited) {
    env.push(`PATH=${PLUGIN_NPM_PREFIX_DIR}/bin:${inherited}`);
  } else {
    console.warn(
      `[plugins] could not read \`${image}\`'s own PATH, so a plugin's globally installed `
      + `binary will not be on PATH — look for it under ${PLUGIN_NPM_PREFIX_DIR}/bin`,
    );
  }
  return env;
}

// Read per call so an image rebuild cannot leave a cached toolchain PATH.
async function imagePath(docker: Docker, image: string): Promise<string | null> {
  try {
    const info = await docker.getImage(image).inspect();
    const entry = (info.Config?.Env ?? []).find((e) => e.startsWith("PATH="));
    return entry ? entry.slice("PATH=".length) : null;
  } catch {
    return null;
  }
}
