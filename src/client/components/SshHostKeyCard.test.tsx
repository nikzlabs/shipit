import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SshHostKeyCard } from "./SshHostKeyCard.js";
import type { SshHostKeyCard as SshHostKeyCardData } from "../../server/shared/types.js";

const base: SshHostKeyCardData = {
  cardId: "c1",
  hostId: "ssh_1",
  label: "prod",
  address: "prod.example.com",
  kind: "recorded",
  fingerprint: "SHA256:seen",
  keyType: "ssh-ed25519",
  createdAt: "2026-09-14T00:00:00.000Z",
};

afterEach(cleanup);

describe("SshHostKeyCard (docs/305 req 9)", () => {
  // The fingerprint is the whole point: the user compares it with the server.
  it("shows the recorded fingerprint and asks the user to compare it", () => {
    render(<SshHostKeyCard card={base} />);
    expect(screen.getByText(/Recorded the host key for prod/)).toBeTruthy();
    expect(screen.getByText(/ssh-ed25519 SHA256:seen/)).toBeTruthy();
    expect(screen.getByText(/Compare this with the server's own fingerprint/)).toBeTruthy();
  });

  it("shows both fingerprints on a mismatch, and says the attempt was refused", () => {
    render(
      <SshHostKeyCard
        card={{ ...base, kind: "mismatch", recordedFingerprint: "SHA256:recorded" }}
      />,
    );
    expect(screen.getByText(/presented a different host key — refused/)).toBeTruthy();
    expect(screen.getByText(/ssh-ed25519 SHA256:seen/)).toBeTruthy();
    expect(screen.getByText("SHA256:recorded")).toBeTruthy();
    // The user clears the pin; the agent cannot, and editing known_hosts does not help.
    expect(screen.getByText(/forget the recorded key in Settings/)).toBeTruthy();
  });

  /**
   * req 13 — nothing was recorded, and the reason is outside the session
   * entirely. The card is the only place the user learns that ShipIt looked at
   * the address and did not find that key.
   */
  it("shows what the orchestrator's own scan saw when a key cannot be verified", () => {
    render(
      <SshHostKeyCard
        card={{ ...base, kind: "unverified", scannedFingerprint: "SHA256:atTheAddress" }}
      />,
    );
    expect(screen.getByText(/Could not verify prod's host key — refused/)).toBeTruthy();
    expect(screen.getByText(/a different key answered at prod.example.com/)).toBeTruthy();
    expect(screen.getByText(/Nothing was recorded/)).toBeTruthy();
    expect(screen.getByText("SHA256:atTheAddress")).toBeTruthy();
    expect(screen.getByText(/ssh-ed25519 SHA256:seen/)).toBeTruthy();
  });

  it("says nothing answered when the scan found no key at all", () => {
    render(<SshHostKeyCard card={{ ...base, kind: "unverified", scanFailure: "no-answer" }} />);
    expect(screen.getByText(/nothing answered there at prod.example.com/)).toBeTruthy();
    expect(screen.queryByText(/Seen at address/)).toBeNull();
  });
});
