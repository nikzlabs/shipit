import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Antigravity CLI has no variable that relocates its config home, so every
 * spawn sets HOME. Two directories live under it and they have different
 * lifetimes:
 *
 * - `~/.gemini/antigravity-cli/` is DURABLE — the OAuth token, conversations,
 *   the `brain/` transcripts, the MCP schema cache and `settings.json`. It is
 *   the credential root ShipIt links into the container.
 * - `~/.gemini/config/` is PER SPAWN — the MCP servers and the ShipIt plugin
 *   that carries this turn's system prompt and skills. A cross-harness
 *   `shipit agent run`, and every spawn in local mode, would otherwise share
 *   one `mcp_config.json` with the session's own turns.
 *
 * So a spawn runs on a throwaway HOME whose `antigravity-cli` is a symlink back
 * to the durable one, and whose `config/` is written fresh.
 */

export const ANTIGRAVITY_CREDENTIAL_DIR = ".gemini";
const CLI_SUBDIR = "antigravity-cli";
const TOKEN_FILENAME = "antigravity-oauth-token";

export function antigravityCliDir(home: string): string {
  return path.join(home, ANTIGRAVITY_CREDENTIAL_DIR, CLI_SUBDIR);
}

/** Root-relative, the shape AGENT_TOKEN_FILES declares. */
export const ANTIGRAVITY_TOKEN_REL = path.join(ANTIGRAVITY_CREDENTIAL_DIR, CLI_SUBDIR, TOKEN_FILENAME);

export function antigravityTokenPath(home: string): string {
  return path.join(antigravityCliDir(home), TOKEN_FILENAME);
}

export function hasAntigravityAccountToken(home: string): boolean {
  try {
    return fs.statSync(antigravityTokenPath(home)).size > 0;
  } catch {
    return false;
  }
}

/**
 * The CLI reads GEMINI_API_KEY only when `settings.json` selects the gemini
 * provider (probed on 1.2.2). The file lives inside the durable directory, so
 * the adapter derives its value from what that directory holds rather than from
 * routing it cannot see on every spawn path: an account token present means the
 * account wins and the key is scrubbed anyway.
 */
export function syncAntigravityModelProvider(home: string, useKey: boolean): void {
  const cliDir = antigravityCliDir(home);
  const file = path.join(cliDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable: start from an empty object.
  }
  const current = settings.modelProvider;
  if (useKey) {
    if (current === "gemini") return;
    settings.modelProvider = "gemini";
  } else {
    if (current === undefined) return;
    delete settings.modelProvider;
  }
  try {
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    console.warn(`[antigravity] could not write ${file}: ${String(err)}`);
  }
}

/**
 * The CLI's model ids drop the catalogue's `-preview` suffix and take the
 * reasoning level as `--effort`, never as part of the id — probed on 1.2.2:
 * `--model gemini-3.1-pro-preview` is "not recognized", `--model gemini-3.1-pro
 * --effort high` reaches `gemini-3.1-pro-preview-customtools` on the wire.
 */
export function antigravityCliModelId(catalogueId: string): string {
  return catalogueId.endsWith("-preview") ? catalogueId.slice(0, -"-preview".length) : catalogueId;
}

export interface AntigravityPluginContent {
  /** Becomes `rules/AGENTS.md`; delivered inside the CLI's own <RULE> block. */
  rules?: string;
  /** Absolute directories symlinked under `skills/`; the CLI follows the links. */
  skillDirs?: string[];
  /** `mcpServers` shape; plugin servers are namespaced `<plugin>_<server>`. */
  mcpServers?: Record<string, unknown>;
}

export interface AntigravitySpawnHome {
  home: string;
  /** False when the durable directory could not be linked; resume is then lost. */
  durableLinked: boolean;
  cleanup: () => void;
}

export const ANTIGRAVITY_PLUGIN_NAME = "shipit";

/**
 * A plugin under `config/plugins/<name>/` loads with NO `import_manifest.json`
 * and no `plugin install` step — probed on 1.2.2 against a redirected endpoint,
 * in a brand-new home: the rule text, a symlinked skill directory and the
 * plugin's own MCP servers all reached the wire. A MALFORMED manifest suppresses
 * loading, so ShipIt writes none.
 */
function writePlugin(configDir: string, content: AntigravityPluginContent): void {
  const pluginDir = path.join(configDir, "plugins", ANTIGRAVITY_PLUGIN_NAME);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    `${JSON.stringify({ name: ANTIGRAVITY_PLUGIN_NAME, version: "1.0.0", description: "ShipIt session integration" }, null, 2)}\n`,
  );
  if (content.rules) {
    const rulesDir = path.join(pluginDir, "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "AGENTS.md"), content.rules);
  }
  if (content.mcpServers && Object.keys(content.mcpServers).length > 0) {
    fs.writeFileSync(
      path.join(pluginDir, "mcp_config.json"),
      `${JSON.stringify({ mcpServers: content.mcpServers }, null, 2)}\n`,
    );
  }
  const skillDirs = content.skillDirs ?? [];
  if (skillDirs.length === 0) return;
  const skillsRoot = path.join(pluginDir, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const source of skillDirs) {
    try {
      fs.symlinkSync(source, path.join(skillsRoot, path.basename(source)));
    } catch (err) {
      console.warn(`[antigravity] could not disclose skill ${source}: ${String(err)}`);
    }
  }
}

export function makeAntigravitySpawnHome(opts: {
  /** The durable home holding `.gemini/`; conversations and the token live here. */
  credentialHome: string;
  plugin?: AntigravityPluginContent;
  label?: string;
}): AntigravitySpawnHome | null {
  let home: string;
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), `${opts.label ?? "antigravity"}-home-`));
  } catch (err) {
    console.error(`[antigravity] could not create a per-spawn home under ${os.tmpdir()}: ${String(err)}`);
    return null;
  }
  const geminiDir = path.join(home, ANTIGRAVITY_CREDENTIAL_DIR);
  const configDir = path.join(geminiDir, "config");
  let durableLinked = false;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const durable = antigravityCliDir(opts.credentialHome);
    fs.mkdirSync(durable, { recursive: true });
    // A directory link: a token refresh renames INSIDE it, so the link survives.
    fs.symlinkSync(durable, path.join(geminiDir, CLI_SUBDIR));
    durableLinked = true;
  } catch (err) {
    console.warn(
      `[antigravity] the durable config root under ${opts.credentialHome} is unusable (${String(err)})`
      + " — this spawn runs self-contained, so conversation resume and any saved account are unavailable.",
    );
    try {
      fs.mkdirSync(path.join(geminiDir, CLI_SUBDIR), { recursive: true });
    } catch {
      // The CLI creates its own under a writable HOME.
    }
  }
  if (opts.plugin) {
    try {
      writePlugin(configDir, opts.plugin);
    } catch (err) {
      console.warn(`[antigravity] could not write this spawn's plugin: ${String(err)}`);
    }
  }
  return {
    home,
    durableLinked,
    cleanup: () => {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // Best effort; /tmp is wiped with the container.
      }
    },
  };
}
