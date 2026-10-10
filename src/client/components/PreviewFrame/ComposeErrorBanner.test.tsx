import { describe, it, expect } from "vitest";
import { getComposeErrorHint } from "./ComposeErrorBanner.js";

describe("getComposeErrorHint", () => {
  it("names where the address-pool setting is on Docker Desktop and on a Linux daemon", () => {
    const hint = getComposeErrorHint(
      "failed to create network shipit-session-abc: Error response from daemon: "
      + "all predefined address pools have been fully subnetted",
    );

    expect(hint).toContain("Settings → Docker Engine");
    expect(hint).toContain("/etc/docker/daemon.json");
  });

  it("has no hint for an error it does not know", () => {
    expect(getComposeErrorHint("service web exited with code 1")).toBeNull();
  });
});
