import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import {
  listMcpServers,
  validateMcpServerConfig,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  MAX_ENABLED_MCP_SERVERS,
} from "./mcp.js";
import { ServiceError } from "./types.js";

describe("services/mcp (docs/088)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function store(): CredentialStore {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-svc-"));
    return new CredentialStore(tmpDir);
  }

  const stdioConfig = {
    name: "linear",
    type: "stdio",
    command: "npx",
    args: ["-y", "@anthropic-ai/linear-mcp"],
    env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
    enabled: true,
  };

  describe("validateMcpServerConfig", () => {
    it("accepts a valid stdio config and defaults enabled", () => {
      const cfg = validateMcpServerConfig({ ...stdioConfig, enabled: undefined });
      expect(cfg.type).toBe("stdio");
      expect(cfg.enabled).toBe(true);
    });

    it("accepts a valid http config", () => {
      const cfg = validateMcpServerConfig({
        name: "sentry",
        type: "http",
        url: "https://mcp.sentry.dev/mcp",
        enabled: true,
      });
      expect(cfg.type).toBe("http");
    });

    it("rejects bad names and reserved names", () => {
      expect(() => validateMcpServerConfig({ ...stdioConfig, name: "Bad Name" })).toThrow(
        ServiceError,
      );
      expect(() => validateMcpServerConfig({ ...stdioConfig, name: "9lives" })).toThrow();
      expect(() => validateMcpServerConfig({ ...stdioConfig, name: "playwright" })).toThrow(
        /reserved/,
      );
    });

    it("rejects shell metacharacters in command", () => {
      expect(() =>
        validateMcpServerConfig({ ...stdioConfig, command: "npx; rm -rf /" }),
      ).toThrow(/metacharacter/);
    });

    it("rejects http config without a valid url", () => {
      expect(() =>
        validateMcpServerConfig({ name: "x", type: "http", url: "not-a-url", enabled: true }),
      ).toThrow(ServiceError);
    });

    it("rejects unknown types", () => {
      expect(() => validateMcpServerConfig({ name: "x", type: "ftp", enabled: true })).toThrow();
    });
  });

  describe("CRUD", () => {
    it("addMcpServer persists config blob + secrets separately", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });

      const saved = cs.getMcpServer("linear");
      expect(saved?.type).toBe("stdio");
      expect((saved as { env?: Record<string, string> }).env?.LINEAR_API_KEY).toBe(
        "$secret:mcp__linear__LINEAR_API_KEY",
      );
      expect(cs.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe("lin_api_abc");
    });

    it("addMcpServer rejects duplicate names with 409", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, {});
      try {
        addMcpServer(cs, stdioConfig, {});
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).statusCode).toBe(409);
      }
    });

    it("addMcpServer rejects secrets outside the server namespace", () => {
      const cs = store();
      expect(() =>
        addMcpServer(cs, stdioConfig, { mcp__sentry__TOKEN: "x" }),
      ).toThrow(ServiceError);
    });

    it("listMcpServers returns the array wire form sorted by name", () => {
      const cs = store();
      addMcpServer(cs, { ...stdioConfig, name: "zeta" }, {});
      addMcpServer(cs, { ...stdioConfig, name: "alpha" }, {});
      expect(listMcpServers(cs).map((s) => s.name)).toEqual(["alpha", "zeta"]);
    });

    it("updateMcpServer rename clears the old server's secrets", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });

      const renamed = {
        ...stdioConfig,
        name: "linearprod",
        env: { LINEAR_API_KEY: "$secret:mcp__linearprod__LINEAR_API_KEY" },
      };
      const { clearedSecretKeys } = updateMcpServer(cs, "linear", renamed, {
        mcp__linearprod__LINEAR_API_KEY: "lin_api_new",
      });

      expect(clearedSecretKeys).toContain("mcp__linear__LINEAR_API_KEY");
      expect(cs.getMcpServer("linear")).toBeUndefined();
      expect(cs.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
      expect(cs.getMcpServer("linearprod")?.name).toBe("linearprod");
      expect(cs.getAgentEnv("mcp__linearprod__LINEAR_API_KEY")).toBe("lin_api_new");
    });

    it("updateMcpServer rename migrates secrets the form cannot resubmit (planning#565)", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });

      // The edit form blanks stored values and labels them "(unchanged)", so a
      // rename submits no replacement for them.
      const renamed = {
        ...stdioConfig,
        name: "linearprod",
        env: { LINEAR_API_KEY: "$secret:mcp__linearprod__LINEAR_API_KEY" },
      };
      const { clearedSecretKeys } = updateMcpServer(cs, "linear", renamed, {});

      expect(cs.getAgentEnv("mcp__linearprod__LINEAR_API_KEY")).toBe("lin_api_abc");
      expect(cs.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
      expect(clearedSecretKeys).toEqual(["mcp__linear__LINEAR_API_KEY"]);
    });

    it("updateMcpServer rename migrates an http server's header secrets", () => {
      const cs = store();
      addMcpServer(
        cs,
        {
          name: "sentry",
          type: "http",
          url: "https://mcp.sentry.dev/mcp",
          headers: { Authorization: "Bearer $secret:mcp__sentry__TOKEN" },
          enabled: true,
        },
        { mcp__sentry__TOKEN: "sntrys_abc" },
      );

      updateMcpServer(
        cs,
        "sentry",
        {
          name: "sentryprod",
          type: "http",
          url: "https://mcp.sentry.dev/mcp",
          headers: { Authorization: "Bearer $secret:mcp__sentryprod__TOKEN" },
          enabled: true,
        },
        {},
      );

      expect(cs.getAgentEnv("mcp__sentryprod__TOKEN")).toBe("sntrys_abc");
      expect(cs.getAgentEnv("mcp__sentry__TOKEN")).toBeUndefined();
    });

    it("updateMcpServer rename does not carry a key the edit removed", () => {
      const cs = store();
      addMcpServer(
        cs,
        {
          ...stdioConfig,
          env: { A: "$secret:mcp__linear__A", B: "$secret:mcp__linear__B" },
        },
        { mcp__linear__A: "a", mcp__linear__B: "b" },
      );

      const { clearedSecretKeys } = updateMcpServer(
        cs,
        "linear",
        { ...stdioConfig, name: "linearprod", env: { A: "$secret:mcp__linearprod__A" } },
        {},
      );

      expect(cs.getAgentEnv("mcp__linearprod__A")).toBe("a");
      expect(cs.getAgentEnv("mcp__linearprod__B")).toBeUndefined();
      expect(clearedSecretKeys.sort()).toEqual(["mcp__linear__A", "mcp__linear__B"]);
    });

    it("updateMcpServer drops a secret the config no longer refers to", () => {
      const cs = store();
      addMcpServer(
        cs,
        {
          ...stdioConfig,
          env: { A: "$secret:mcp__linear__A", B: "$secret:mcp__linear__B" },
        },
        { mcp__linear__A: "a", mcp__linear__B: "b" },
      );

      const { clearedSecretKeys } = updateMcpServer(
        cs,
        "linear",
        { ...stdioConfig, env: { A: "$secret:mcp__linear__A" } },
        {},
      );

      expect(cs.getAgentEnv("mcp__linear__A")).toBe("a");
      expect(cs.getAgentEnv("mcp__linear__B")).toBeUndefined();
      expect(clearedSecretKeys).toEqual(["mcp__linear__B"]);
    });

    it("updateMcpServer keeps stored secrets when a save submits none", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });

      // The enabled toggle re-submits the stored config with no secrets at all.
      const { clearedSecretKeys } = updateMcpServer(
        cs,
        "linear",
        { ...stdioConfig, enabled: false },
        {},
      );

      expect(cs.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe("lin_api_abc");
      expect(clearedSecretKeys).toEqual([]);
    });

    it("updateMcpServer rename moves references the caller left under the old name", () => {
      const cs = store();
      const before = {
        name: "linear",
        type: "stdio",
        command: "npx",
        args: ["--token", "$secret:mcp__linear__TOKEN"],
        env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
        enabled: true,
      };
      addMcpServer(cs, before, {
        mcp__linear__TOKEN: "tok",
        mcp__linear__LINEAR_API_KEY: "key",
      });

      // A caller that renames the server without rewriting its own references —
      // the form cannot rewrite `args` at all.
      const { config } = updateMcpServer(cs, "linear", { ...before, name: "linearprod" }, {});

      expect((config as { args?: string[] }).args).toEqual([
        "--token",
        "$secret:mcp__linearprod__TOKEN",
      ]);
      expect((config as { env?: Record<string, string> }).env).toEqual({
        LINEAR_API_KEY: "$secret:mcp__linearprod__LINEAR_API_KEY",
      });
      expect(cs.getAgentEnv("mcp__linearprod__TOKEN")).toBe("tok");
      expect(cs.getAgentEnv("mcp__linearprod__LINEAR_API_KEY")).toBe("key");
      expect(cs.getAgentEnv("mcp__linear__TOKEN")).toBeUndefined();
    });

    it("updateMcpServer does not clear a secret another server still refers to", () => {
      const cs = store();
      addMcpServer(
        cs,
        { ...stdioConfig, env: { A: "$secret:mcp__linear__SHARED" } },
        { mcp__linear__SHARED: "shared" },
      );
      addMcpServer(
        cs,
        { ...stdioConfig, name: "sentry", env: { B: "$secret:mcp__linear__SHARED" } },
        {},
      );

      const { clearedSecretKeys } = updateMcpServer(
        cs,
        "linear",
        { ...stdioConfig, env: {} },
        {},
      );

      expect(cs.getAgentEnv("mcp__linear__SHARED")).toBe("shared");
      expect(clearedSecretKeys).toEqual([]);
    });

    it("updateMcpServer keeps a secret referenced only from args", () => {
      const cs = store();
      // `args` values are substituted too (session/mcp-resolve.ts), so a
      // reference there is as live as one in `env`.
      const argsConfig = {
        name: "linear",
        type: "stdio",
        command: "npx",
        args: ["-y", "@anthropic-ai/linear-mcp", "--token", "$secret:mcp__linear__TOKEN"],
        enabled: true,
      };
      addMcpServer(cs, argsConfig, { mcp__linear__TOKEN: "lin_api_abc" });

      const { clearedSecretKeys } = updateMcpServer(
        cs,
        "linear",
        { ...argsConfig, enabled: false },
        {},
      );

      expect(cs.getAgentEnv("mcp__linear__TOKEN")).toBe("lin_api_abc");
      expect(clearedSecretKeys).toEqual([]);
    });

    it("updateMcpServer keeps secrets across a transport change", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });

      // The new bag is `headers`, not `env`; the secret keys do not move with it.
      const { clearedSecretKeys } = updateMcpServer(
        cs,
        "linear",
        {
          name: "linear",
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer $secret:mcp__linear__LINEAR_API_KEY" },
          enabled: true,
        },
        {},
      );

      expect(cs.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe("lin_api_abc");
      expect(clearedSecretKeys).toEqual([]);
    });

    it("updateMcpServer leaves another server's secrets alone", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });
      addMcpServer(cs, { ...stdioConfig, name: "sentry", env: undefined }, {});
      cs.setMcpSecret("mcp__sentry__TOKEN", "sntrys_abc");

      updateMcpServer(cs, "linear", { ...stdioConfig, name: "linearprod", env: {} }, {});

      expect(cs.getAgentEnv("mcp__sentry__TOKEN")).toBe("sntrys_abc");
    });

    it("removeMcpServer drops the blob and reports cleared secret keys", () => {
      const cs = store();
      addMcpServer(cs, stdioConfig, { mcp__linear__LINEAR_API_KEY: "lin_api_abc" });
      const { clearedSecretKeys } = removeMcpServer(cs, "linear");

      expect(clearedSecretKeys).toEqual(["mcp__linear__LINEAR_API_KEY"]);
      expect(cs.getMcpServer("linear")).toBeUndefined();
      expect(cs.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
    });

    it("removeMcpServer 404s for unknown ids", () => {
      const cs = store();
      expect(() => removeMcpServer(cs, "nope")).toThrow(ServiceError);
    });

    it("enforces the enabled-server cap", () => {
      const cs = store();
      for (let i = 0; i < MAX_ENABLED_MCP_SERVERS; i++) {
        addMcpServer(cs, { ...stdioConfig, name: `srv${i}` }, {});
      }
      expect(() =>
        addMcpServer(cs, { ...stdioConfig, name: "onetoomany" }, {}),
      ).toThrow(/more than/);

      expect(() =>
        addMcpServer(cs, { ...stdioConfig, name: "disabledok", enabled: false }, {}),
      ).not.toThrow();
    });
  });
});
