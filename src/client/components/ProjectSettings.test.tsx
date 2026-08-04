import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSettings, type ProjectSettingsProps } from "./ProjectSettings.js";
import { usePreviewStore } from "../stores/preview-store.js";

afterEach(() => {
  cleanup();
  usePreviewStore.getState().setSecrets({
    declared: [],
    missingByService: {},
    missingRequired: [],
  });
});

const defaultProps: ProjectSettingsProps = {
  repoUrl: "https://github.com/org/repo",
  repoName: "org/repo",
  onClose: vi.fn(),
};

describe("ProjectSettings", () => {
  it("renders dialog with header and repo name", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Project Settings")).toBeInTheDocument();
    expect(screen.getByText("org/repo")).toBeInTheDocument();
  });

  it("opens on the Secrets tab by default", async () => {
    render(<ProjectSettings {...defaultProps} onSecretsLoad={async () => []} />);
    await waitFor(() => {
      expect(screen.getByTestId("secrets-tab")).toBeInTheDocument();
    });
  });

  it("opens on the Deployments tab when initialTab is deployments", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByTestId("deployments-tab")).toBeInTheDocument();
  });

  it("calls onClose on Escape key", async () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on close button (x) click", async () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ProjectSettings - Deployments tab", () => {
  it("shows setup guide", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByTestId("deployments-tab")).toBeInTheDocument();
    expect(screen.getByText("Automatic Deployments")).toBeInTheDocument();
  });

  it("shows platform links", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
    expect(screen.getByText("Netlify")).toBeInTheDocument();
  });

  it("shows how-it-works steps", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByText(/Deploy status appears/)).toBeInTheDocument();
  });
});

describe("ProjectSettings - Secrets tab", () => {
  function renderOnSecretsTab(props: Partial<ProjectSettingsProps> = {}) {
    return render(
      <ProjectSettings
        {...defaultProps}
        initialTab="secrets"
        onSecretsLoad={async () => []}
        onSecretsSave={vi.fn()}
        {...props}
      />,
    );
  }

  it("renders secrets tab content", async () => {
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secrets-tab")).toBeInTheDocument();
    });
    expect(screen.getByText("Environment Variables")).toBeInTheDocument();
  });

  it("loads existing secret names on render (values never sent to client)", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue(["API_KEY"]);
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
    // The value field is blank (the browser never received the value) and
    // signals a stored value via its placeholder.
    expect(screen.getByTestId("secret-value-0")).toHaveValue("");
    expect(screen.getByTestId("secret-value-0")).toHaveAttribute(
      "placeholder",
      expect.stringContaining("saved"),
    );
  });

  it("adds a new row when Add variable is clicked", async () => {
    renderOnSecretsTab({ onSecretsLoad: async () => [] });

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));
    expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
  });

  it("removes a row when remove button is clicked", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue(["KEY_A", "KEY_B"]);
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-remove-0"));
    expect(screen.queryByTestId("secret-key-1")).not.toBeInTheDocument();
  });

  it("calls onSecretsSave with a set/keep payload on save", async () => {
    const onSecretsSave = vi.fn();
    const onSecretsLoad = vi.fn().mockResolvedValue([]);
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));
    fireEvent.change(screen.getByTestId("secret-key-0"), { target: { value: "MY_KEY" } });
    fireEvent.change(screen.getByTestId("secret-value-0"), { target: { value: "my_value" } });

    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { set: { MY_KEY: "my_value" }, keep: [] },
    );
  });

  it("keeps an untouched existing custom secret without resending its value", async () => {
    const onSecretsSave = vi.fn();
    const onSecretsLoad = vi.fn().mockResolvedValue(["API_KEY"]);
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });

    // Don't touch the value — save must keep it by name only.
    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { set: {}, keep: ["API_KEY"] },
    );
  });

  it("secret values use password input type", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue(["KEY"]);
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
    });
    expect(screen.getByTestId("secret-value-0")).toHaveAttribute("type", "password");
  });

  it("renders declared secrets from preview-store snapshot", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api", "web"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => [] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });
    expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toHaveTextContent("api");
    expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toHaveTextContent("web");
  });

  it("shows Required indicator when value is missing", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "DATABASE_URL", required: true, services: ["api"] }],
      missingByService: { api: ["DATABASE_URL"] },
      missingRequired: ["DATABASE_URL"],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => [] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-required-DATABASE_URL")).toBeInTheDocument();
    });
  });

  it("renders platform-sourced rows as read-only", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "GITHUB_TOKEN", source: "platform:github_token", services: ["orchestrator"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => [] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-platform-GITHUB_TOKEN")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("secret-value-GITHUB_TOKEN")).not.toBeInTheDocument();
  });

  it("editing a declared (non-platform) value persists it on save", async () => {
    const onSecretsSave = vi.fn();
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad: async () => [] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-value-STRIPE_KEY")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("secret-value-STRIPE_KEY"), {
      target: { value: "sk_live_x" },
    });
    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { set: { STRIPE_KEY: "sk_live_x" }, keep: [] },
    );
  });

  // A stored key renders under "Custom variables" only until `secrets_status`
  // says a compose service declared it. The snapshot is live, so it can arrive
  // after the tab mounted — and after the user pinned `customRows` by touching
  // a row. The key must still move into the declared section rather than
  // rendering in both.
  it("moves a stored key out of Custom variables when it becomes declared", async () => {
    renderOnSecretsTab({ onSecretsLoad: async () => ["STRIPE_KEY", "OTHER"] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });
    // Pin `customRows` the way any edit would.
    await userEvent.click(screen.getByTestId("secret-add"));

    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });

    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });
    const customKeys = screen
      .getAllByTestId(/^secret-key-\d+$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(customKeys).not.toContain("STRIPE_KEY");
    expect(customKeys).toContain("OTHER");
  });

  // The rendered custom list is filtered, so row handlers must index the
  // FILTERED list. Indexing the pinned `customRows` state instead is off by
  // however many keys have since moved into the declared section — the click
  // would remove the wrong row.
  it("removes the clicked custom row after a key moved to the declared section", async () => {
    renderOnSecretsTab({ onSecretsLoad: async () => ["STRIPE_KEY", "KEEP_ME", "DROP_ME"] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });
    // Pin `customRows` while STRIPE_KEY is still in it.
    await userEvent.click(screen.getByTestId("secret-add"));

    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("KEEP_ME");
    });

    // Rendered: [KEEP_ME, DROP_ME, ""] — index 1 is DROP_ME.
    await userEvent.click(screen.getByTestId("secret-remove-1"));
    const customKeys = screen
      .getAllByTestId(/^secret-key-\d+$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(customKeys).toEqual(["KEEP_ME", ""]);
  });

  // A key hidden from the custom section is hidden, not dropped: `declared` can
  // go back to empty (compose file edited again), and a row removed from state
  // would then be in neither section — so Save would put it in neither `set`
  // nor `keep` and the server would delete the stored secret.
  it("does not drop a stored key that was hidden while declared and then undeclared", async () => {
    const onSecretsSave = vi.fn();
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad: async () => ["STRIPE_KEY"] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });

    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });
    // Pin `customRows` while STRIPE_KEY is filtered out of the rendered list.
    await userEvent.click(screen.getByTestId("secret-add"));

    // The compose file drops `x-shipit-secrets` again.
    usePreviewStore.getState().setSecrets({
      declared: [],
      missingByService: {},
      missingRequired: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });

    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { set: {}, keep: ["STRIPE_KEY"] },
    );
  });

  it("clears a set declared value via the Clear control", async () => {
    const onSecretsSave = vi.fn();
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    // STRIPE_KEY already has a stored value (name returned by load).
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad: async () => ["STRIPE_KEY"] });
    await waitFor(() => {
      expect(screen.getByTestId("secret-clear-STRIPE_KEY")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-clear-STRIPE_KEY"));
    await userEvent.click(screen.getByTestId("secrets-save"));
    // Cleared → neither set nor kept → server deletes it.
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { set: {}, keep: [] },
    );
  });
});
