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
});
