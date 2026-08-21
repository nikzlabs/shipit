// docs/262 req 23 — claimant chips: which services AND which plugins use a
// declared secret. A name claimed by both is one row, because it is one
// stored secret (plan §3).

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { DeclaredSecretRow, isPlatformProvided } from "./DeclaredSecretRow.js";
import type { DeclaredSecretState } from "../stores/preview-store.js";

function renderRow(requirement: DeclaredSecretState) {
  render(
    <DeclaredSecretRow
      requirement={requirement}
      value=""
      isSet={false}
      missing={{}}
      onChange={() => {}}
      onClear={() => {}}
    />,
  );
}

describe("DeclaredSecretRow claimants", () => {
  afterEach(cleanup);

  it("lists a plugin alias beside the consuming services", () => {
    renderRow({ name: "FAL_KEY", services: ["api"], plugins: ["artk"] });
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByTestId("secret-plugin-claimant-FAL_KEY-artk")).toBeTruthy();
  });

  it("a plugin-only credential still renders a settable row", () => {
    renderRow({ name: "FAL_KEY", services: [], plugins: ["artk"] });
    expect(screen.getByTestId("secret-plugin-claimant-FAL_KEY-artk")).toBeTruthy();
    // No "Required" badge: a plugin never marks a project's secret required.
    expect(screen.queryByTestId("secret-required-FAL_KEY")).toBeNull();
  });

  it("a compose-only secret is unchanged — no plugin chips", () => {
    renderRow({ name: "DATABASE_URL", services: ["api"] });
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.queryByTestId(/secret-plugin-claimant/)).toBeNull();
  });

  it("shows a satisfied plugin credential as an editable row, not a gap", () => {
    renderRow({ name: "FAL_KEY", services: [], plugins: ["artk"] });
    expect(screen.getByTestId("secret-value-FAL_KEY")).toBeTruthy();
  });
});

describe("isPlatformProvided", () => {
  it("a legacy platform row a plugin also claims stays editable", () => {
    // Platform forwarding is dead (docs/184), so a plugin declaring the same
    // name needs a real value — and this row is where the card's "Add key…"
    // sends the user. Read-only here would make the plugin unsatisfiable.
    const merged: DeclaredSecretState = {
      name: "GITHUB_TOKEN",
      services: ["api"],
      source: "platform:github_token",
      plugins: ["artk"],
    };
    expect(isPlatformProvided(merged)).toBe(false);
    renderRow(merged);
    expect(screen.getByTestId("secret-value-GITHUB_TOKEN")).toBeTruthy();
    expect(screen.queryByTestId("secret-platform-GITHUB_TOKEN")).toBeNull();
  });

  it("a platform row no plugin claims stays read-only", () => {
    const platformOnly: DeclaredSecretState = {
      name: "GITHUB_TOKEN",
      services: ["api"],
      source: "platform:github_token",
    };
    expect(isPlatformProvided(platformOnly)).toBe(true);
    renderRow(platformOnly);
    expect(screen.queryByTestId("secret-value-GITHUB_TOKEN")).toBeNull();
    expect(screen.getByTestId("secret-platform-GITHUB_TOKEN")).toBeTruthy();
  });
});
