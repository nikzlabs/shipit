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

/**
 * A name the user could store that carries a credential.
 *
 * **This is what the fixtures were blind to.** Every one of them planted the
 * token in a field's VALUE, so a projection that emitted a NAME unchanged passed
 * the whole suite — and `project.secrets` did exactly that, in the index, in
 * every item's address, in text and in `--json`, because an item's address is
 * projected through its collection. Nothing stops the user storing this: the
 * secrets route takes any string as a key and a role name is checked only for
 * being non-blank and short enough.
 */
const CREDENTIAL_NAME = `https://user:${TOKEN}@host.example.com/path?token=${TOKEN}`; // gitleaks:allow

/**
 * The same sentinel, planted in every OTHER projection that derives its output.
 * A `derived` projection is an arbitrary function, so no structural rule can say
 * it is safe — a fixture per projection is what can, and the coverage test below
 * fails when a new one arrives without one.
 */
const DERIVED_FIXTURES: Record<string, unknown> = {
  "mcp.servers": [
    { name: "notion", type: "http", url: `https://x@h/${TOKEN}`, headers: { A: TOKEN } },
    { name: "sentry", type: "stdio", command: "npx", args: [`--token=${TOKEN}`] },
    { name: CREDENTIAL_NAME, type: "stdio", command: "npx" },
  ],
  "services.credentials": [
    { id: "route-1", label: "Personal", secret: TOKEN },
    { id: "route-2", label: "Work", secret: TOKEN },
  ],
  "services.providerAccounts": [{ id: "acct-1", label: "Work", accessToken: TOKEN }],
  "roles": [
    { name: "deep-dive", prompt: `Use ${TOKEN}`, params: { modelId: "m" } },
    { name: CREDENTIAL_NAME, params: { modelId: "m" } },
  ],
  "reviewers": [
    { slot: "first", source: "pinned", pin: { modelId: `m-${TOKEN}` } },
    { slot: "second", source: "auto" },
  ],
  "network.egress.hosts": [
    "api.example.com",
    // The box takes any text, so a pasted URL is a possible stored entry.
    `https://svc:${TOKEN}@example.com/hook?token=${TOKEN}`, // gitleaks:allow
  ],
  "network.egress.hosts[].host": `https://svc:${TOKEN}@example.com/hook?token=${TOKEN}`, // gitleaks:allow
  "project.secrets": { SENTRY_DSN: TOKEN, DATABASE_URL: TOKEN, [CREDENTIAL_NAME]: "x" },
  // docs/305 — the reader passes the public projection today, so this fixture is
  // deliberately the STORED record instead: the projection has to drop the
  // private key even if a later change hands it the wrong shape. The token
  // stands in for the key with no PEM armour, which would only make a fake
  // value look real to a secret scanner without strengthening the assertion.
  "integrations.sshHosts": [
    {
      id: "ssh_1",
      label: "prod",
      address: "prod.example.com",
      user: "deploy",
      privateKeyPem: TOKEN,
      identityLine: `ssh-ed25519 AAAA ${TOKEN}`,
      authorizedKeysLine: `no-agent-forwarding ssh-ed25519 AAAA ${TOKEN}`,
      hostKeyBlob: TOKEN,
    },
    { id: "ssh_2", label: "staging", address: "10.0.0.5", user: "root", privateKeyPem: TOKEN },
    // A label is free text, so a pasted URL is a possible stored value.
    { id: "ssh_3", label: CREDENTIAL_NAME, address: "x.example.com", user: "root" },
  ],
  // The route gates both to a shape, so these fixtures are what a store the
  // route never touched could hold — the projection is the door, not the route.
  "integrations.sshHosts[].address": `https://svc:${TOKEN}@prod.example.com/p?token=${TOKEN}`, // gitleaks:allow
  "integrations.sshHosts[].user": `deploy ${TOKEN}`,
  // A level is a word from the harness's own list, and this projection exists
  // to say that an empty one is no level at all. The fixture is still what an
  // unconstrained store could hold: the gate is a door, not the writer.
  "roles[].reasoningEffort": `high ${TOKEN}`,
};

/**
 * The `user_name` declarations: the user's own name for one item, emitted
 * because naming it is what the agent has to do, and only when it is shaped
 * like a name. Same fixture discipline as the derived ones — a new `user_name`
 * declaration without an entry fails the coverage test below.
 */
const USER_NAME_FIXTURES: Record<string, unknown> = {
  "roles[].name": CREDENTIAL_NAME,
  "mcp.servers[].name": CREDENTIAL_NAME,
  "project.secrets[].name": CREDENTIAL_NAME,
  "integrations.sshHosts[].label": CREDENTIAL_NAME,
};

function declarationFor(key: string): AnySettingDeclaration {
  const found = ALL_SETTINGS.find((d) => d.key === key);
  if (!found) throw new Error(`No declaration for ${key}`);
  return found;
}

/** Every output path a reader can reach, for one declaration and one value. */
function outputsOf(key: string, raw: unknown): string[] {
  const declaration = declarationFor(key);
  const outcome = projectSetting(declaration, raw);
  const validation = declaration.type.validate(raw, declaration.label);
  return [
    JSON.stringify(outcome),
    formatSetting(declaration, outcome),
    // What a proposal card would show as the value being replaced.
    JSON.stringify({ from: outcome.readable ? outcome.value : null }),
    validation.ok ? "" : validation.message,
  ];
}

const mcpFields = ALL_SETTINGS.filter((d) => d.key.startsWith("mcp.servers[]"));

describe("MCP projections", () => {
  it("puts every declared MCP field through the leak fixture", () => {
    expect(mcpFields.map((d) => d.key).sort()).toEqual(Object.keys(MCP_FIXTURE).sort());
  });

  for (const [key, raw] of Object.entries(MCP_FIXTURE)) {
    it(`emits no credential material from ${key}`, () => {
      for (const output of outputsOf(key, raw)) {
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
    const outcome = projectSetting(
      INTEGRATIONS_SETTINGS["mcp.servers"],
      DERIVED_FIXTURES["mcp.servers"],
    );

    expect(outcome).toEqual({ readable: true, value: ["notion", "sentry"] });
  });

  it("emits an unparseable URL as nothing at all", () => {
    const outcome = projectSetting(declarationFor("mcp.servers[].url"), `not a url ${TOKEN}`);

    expect(outcome).toEqual({ readable: true, value: { scheme: null, host: null } });
  });
});

describe("every other derived projection", () => {
  it("has a leak fixture of its own", () => {
    const derivedKeys = ALL_SETTINGS
      .filter((d) => d.emits.kind === "derived" && !d.key.startsWith("mcp.servers[]"))
      .map((d) => d.key);

    expect(derivedKeys.sort()).toEqual(Object.keys(DERIVED_FIXTURES).sort());
  });

  for (const [key, raw] of Object.entries(DERIVED_FIXTURES)) {
    it(`emits no credential material from ${key}`, () => {
      for (const output of outputsOf(key, raw)) {
        expect(output).not.toContain(TOKEN);
      }
    });
  }

  it("keeps a credential list to ids, whatever the caller holds", () => {
    const outcome = projectSetting(
      SERVICES_SETTINGS["services.credentials"],
      DERIVED_FIXTURES["services.credentials"],
    );

    expect(outcome).toEqual({ readable: true, value: ["route-1", "route-2"] });
  });

  // The name gate the other name-addressed collections use: the labels the user
  // chose are emitted, and the one shape that carries a credential without
  // anyone choosing to — a URL pasted into the name box — is named by nothing.
  it("emits only the destinations' names, never their key material", () => {
    const outcome = projectSetting(
      declarationFor("integrations.sshHosts"),
      DERIVED_FIXTURES["integrations.sshHosts"],
    );

    expect(outcome).toEqual({ readable: true, value: ["prod", "staging"] });
  });

  /*
    The two near neighbours are deliberately not reused, and this is the record
    of why: `hostEntryProjection` refuses every IPv6 literal, which docs/305
    req 12 admits, and `userNameProjection` requires an alphanumeric first
    character, which `requireUser` does not. Either reuse would have emitted a
    stored value as nothing at all, silently.
  */
  it("emits an SSH destination's own address and login, IPv6 and a leading underscore included", () => {
    const address = declarationFor("integrations.sshHosts[].address");
    for (const value of ["prod.example.com", "10.0.0.5", "2001:db8::1", "::1", "2001:db8::"]) {
      expect(projectSetting(address, value), value).toEqual({ readable: true, value });
    }

    const user = declarationFor("integrations.sshHosts[].user");
    for (const value of ["deploy", "_svc", "ci-runner", "root.admin"]) {
      expect(projectSetting(user, value), value).toEqual({ readable: true, value });
    }
  });

  it("drops an allowlist entry that is not a host, since it can match none", () => {
    const outcome = projectSetting(
      declarationFor("network.egress.hosts"),
      DERIVED_FIXTURES["network.egress.hosts"],
    );

    expect(outcome).toEqual({ readable: true, value: ["api.example.com"] });
  });

  it("names the secrets that are set and never their values", () => {
    const outcome = projectSetting(
      declarationFor("project.secrets"),
      DERIVED_FIXTURES["project.secrets"],
    );

    // The two that are names come back; the one shaped like a credential does
    // not, so it produces no item for `settings-read.ts` to address either.
    expect(outcome).toEqual({ readable: true, value: ["SENTRY_DSN", "DATABASE_URL"] });
  });

  it("keeps the roles and servers whose names ARE names", () => {
    expect(projectSetting(declarationFor("roles"), DERIVED_FIXTURES.roles))
      .toEqual({ readable: true, value: ["deep-dive"] });
    expect(projectSetting(declarationFor("mcp.servers"), DERIVED_FIXTURES["mcp.servers"]))
      .toEqual({ readable: true, value: ["notion", "sentry"] });
  });
});

/**
 * req 2 through the one path the fixtures above could not see: an item's
 * ADDRESS. It is projected through the collection that owns the key, so a name
 * that gets out here gets out in the index, in the address, in text and in
 * `--json` at once.
 */
describe("a name the user typed", () => {
  it("has a leak fixture for every declaration that emits one", () => {
    const keys = ALL_SETTINGS.filter((d) => d.emits.kind === "user_name").map((d) => d.key);

    expect(keys.sort()).toEqual(Object.keys(USER_NAME_FIXTURES).sort());
  });

  for (const [key, raw] of Object.entries(USER_NAME_FIXTURES)) {
    it(`emits no credential material from ${key}`, () => {
      for (const output of outputsOf(key, raw)) {
        expect(output).not.toContain(TOKEN);
        expect(output).not.toContain("host.example.com");
      }
    });
  }

  it("still emits the names people actually use", () => {
    const role = declarationFor("roles[].name");
    for (const name of ["reviewer", "deep-dive", "Deep Dive", "code_review (fast)", "ops.v2"]) {
      expect(projectSetting(role, name)).toEqual({ readable: true, value: name });
    }
  });

  it("drops a name carrying URL punctuation, whitespace-padded or not", () => {
    const secret = declarationFor("project.secrets[].name");
    for (const name of [
      `  ${CREDENTIAL_NAME}  `,
      "user@host",
      "a/b",
      "a?b=c",
      "a#b",
      "%2e%2e",
      "",
      "   ",
      "x".repeat(201),
    ]) {
      expect(projectSetting(secret, name)).toEqual({ readable: true, value: null });
    }
    // …and stops exactly at the cap rather than one short of it.
    expect(projectSetting(secret, "x".repeat(200))).toEqual({
      readable: true,
      value: "x".repeat(200),
    });
  });

  it("emits a name verbatim, so the address it gives out addresses the same item", () => {
    // The emitted name IS the address the agent is told to name a change by, and
    // the stores behind one look an item up exactly — `getRole` reads
    // `roles[name]` and neither write path normalizes. A projection that trimmed
    // would emit `"helper"` for a role stored as `" helper "`, which resolves to
    // a DIFFERENT role or to none, and would emit one address twice when both
    // exist.
    const role = declarationFor("roles[].name");
    const padded = " helper ";

    expect(projectSetting(role, padded)).toEqual({ readable: true, value: null });
    expect(projectSetting(role, "helper ")).toEqual({ readable: true, value: null });
    expect(projectSetting(role, "helper")).toEqual({ readable: true, value: "helper" });

    // …and the collection the address is projected through agrees, so the two
    // cannot disagree about which items exist.
    expect(projectSetting(declarationFor("roles"), [{ name: padded }, { name: "helper" }]))
      .toEqual({ readable: true, value: ["helper"] });
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
