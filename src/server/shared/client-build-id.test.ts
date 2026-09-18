import { describe, expect, it } from "vitest";
import { clientBuildIdDefine } from "./client-build-id.js";

const head = () => "head-sha";

describe("clientBuildIdDefine", () => {
  // A dev server's define is frozen at startup, so any id it hands out makes the client
  // reload forever once the orchestrator's HEAD moves past it.
  it("defines no build id for a dev server, even when one is configured", () => {
    expect(clientBuildIdDefine("serve", {}, head)).toEqual({});
    expect(clientBuildIdDefine("serve", { SHIPIT_BUILD_ID: "abc" }, head)).toEqual({});
    expect(clientBuildIdDefine("serve", { VITE_SHIPIT_BUILD_ID: "abc" }, head)).toEqual({});
  });

  it("defines the git HEAD for a production build", () => {
    expect(clientBuildIdDefine("build", {}, head)).toEqual({
      __SHIPIT_CLIENT_BUILD_ID__: '"head-sha"',
    });
  });

  it("prefers an explicit build id over git, VITE_ first", () => {
    expect(clientBuildIdDefine("build", { SHIPIT_BUILD_ID: " env-sha " }, head)).toEqual({
      __SHIPIT_CLIENT_BUILD_ID__: '"env-sha"',
    });
    expect(
      clientBuildIdDefine("build", { VITE_SHIPIT_BUILD_ID: "vite-sha", SHIPIT_BUILD_ID: "env-sha" }, head),
    ).toEqual({ __SHIPIT_CLIENT_BUILD_ID__: '"vite-sha"' });
  });

  it("omits the define when no id resolves, so the client reads it as absent", () => {
    expect(clientBuildIdDefine("build", { SHIPIT_BUILD_ID: "   " }, () => undefined)).toEqual({});
    expect(clientBuildIdDefine("build", {}, () => "\n")).toEqual({});
  });
});
