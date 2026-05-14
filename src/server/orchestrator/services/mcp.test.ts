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
      // Blob keeps the placeholder, not the raw value.
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

      // Disabled servers don't count against the cap.
      expect(() =>
        addMcpServer(cs, { ...stdioConfig, name: "disabledok", enabled: false }, {}),
      ).not.toThrow();
    });
  });
});
