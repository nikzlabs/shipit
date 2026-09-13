import { describe, expect, it } from "vitest";
import { INTEGRATIONS_SETTINGS } from "./integrations-settings.js";
import { SERVICES_SETTINGS } from "./services-settings.js";
import { formatSetting, projectSetting, refusalSentence } from "./projection.js";
import { ALL_SETTINGS } from "./registry.js";
import { BROWSER_SETTINGS } from "./browser-settings.js";
import type { AnySettingDeclaration } from "./types.js";

/**
 * plan.md → `emits` is an allowlist of derived values: an MCP entry carrying a
 * token in `args`, `env`, `headers` **and** the URL emits none of them, in any
 * output a reader can reach.
 */

const TOKEN = "THE-CREDENTIAL-THAT-MUST-NOT-BE-EMITTED";

/**
 * One field per declaration, each carrying the token. A new MCP field must be
 * added here — the coverage test below fails until it is, which is what stops a
 * field shipping without a projection anyone checked.
 */
const MCP_FIXTURE: Record<string, unknown> = {
  "mcp.servers[].name": "notion",
  "mcp.servers[].type": "http",
  "mcp.servers[].enabled": true,
  "mcp.servers[].command": `/opt/bin/start-mcp --token=${TOKEN}`,
  "mcp.servers[].args": ["-y", "@acme/mcp-server", `--token=${TOKEN}`],
  "mcp.servers[].npmPackage": `@acme/mcp-server-${TOKEN}`,
  // The user information is half the point — a token travels there. The marker
  // is for ShipIt's own secret scanner, which cannot tell a fixture from a real
  // credential URL and would otherwise refuse the commit.
  "mcp.servers[].url": `https://svc:${TOKEN}@mcp.example.com/v1/${TOKEN}?api_key=${TOKEN}#${TOKEN}`, // gitleaks:allow
  "mcp.servers[].env": { SENTRY_AUTH_TOKEN: TOKEN, PATH: "/usr/bin" },
  "mcp.servers[].headers": { Authorization: `Bearer ${TOKEN}` },
};

const mcpFields = ALL_SETTINGS.filter((d) => d.key.startsWith("mcp.servers[]"));

function declarationFor(key: string): AnySettingDeclaration {
  const found = mcpFields.find((d) => d.key === key);
  if (!found) throw new Error(`No declaration for ${key}`);
  return found;
}

describe("MCP projections", () => {
  it("puts every declared MCP field through the leak fixture", () => {
    expect(mcpFields.map((d) => d.key).sort()).toEqual(Object.keys(MCP_FIXTURE).sort());
  });

  for (const [key, raw] of Object.entries(MCP_FIXTURE)) {
    it(`emits no credential material from ${key}`, () => {
      const declaration = declarationFor(key);
      const outcome = projectSetting(declaration, raw);

      // The four output paths a reader can reach: the value itself, the text a
      // read prints, the `from` a proposal card would show, and an error.
      const asJson = JSON.stringify(outcome);
      const asText = formatSetting(declaration, outcome);
      const cardFrom = JSON.stringify({ from: outcome.readable ? outcome.value : null });
      const validation = declaration.type.validate(raw, declaration.label);
      const asError = validation.ok ? "" : validation.message;

      for (const output of [asJson, asText, cardFrom, asError]) {
        expect(output).not.toContain(TOKEN);
      }
    });
  }

  it("still says what the URL is, having dropped everything else of it", () => {
    const outcome = projectSetting(
      declarationFor("mcp.servers[].url"),
      MCP_FIXTURE["mcp.servers[].url"],
    );

    expect(outcome).toEqual({ readable: true, value: { scheme: "https", host: "mcp.example.com" } });
  });

  it("says a credential-bearing field is configured without saying what it holds", () => {
    const env = declarationFor("mcp.servers[].env");

    expect(formatSetting(env, projectSetting(env, MCP_FIXTURE["mcp.servers[].env"])))
      .toBe("configured");
    expect(formatSetting(env, projectSetting(env, {}))).toBe("not configured");
  });

  it("emits only the names of the servers, not the servers", () => {
    const servers = [
      { name: "notion", type: "http", url: `https://x@h/${TOKEN}`, headers: { A: TOKEN } },
      { name: "sentry", type: "stdio", command: "npx", args: [`--token=${TOKEN}`] },
    ];
    const outcome = projectSetting(INTEGRATIONS_SETTINGS["mcp.servers"], servers);

    expect(outcome).toEqual({ readable: true, value: ["notion", "sentry"] });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("emits an unparseable URL as nothing at all", () => {
    const outcome = projectSetting(declarationFor("mcp.servers[].url"), `not a url ${TOKEN}`);

    expect(outcome).toEqual({ readable: true, value: { scheme: null, host: null } });
  });
});

describe("projections elsewhere", () => {
  it("keeps a credential order to ids, whatever the caller holds", () => {
    const routes = [
      { id: "route-1", label: "Personal", secret: TOKEN },
      { id: "route-2", label: "Work", secret: TOKEN },
    ];
    const outcome = projectSetting(SERVICES_SETTINGS["services.credentialOrder"], routes);

    expect(outcome).toEqual({ readable: true, value: ["route-1", "route-2"] });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("refuses a browser-local read with the sentence the dialog's user would recognise", () => {
    const declaration = BROWSER_SETTINGS["voice.handsFree"];
    const outcome = projectSetting(declaration, true);

    expect(outcome).toEqual({
      readable: false,
      reason: "browser_local",
      explanation: "Set in the browser; ShipIt's server does not hold this value.",
    });
    expect(formatSetting(declaration, outcome)).toBe(refusalSentence("browser_local"));
  });
});
