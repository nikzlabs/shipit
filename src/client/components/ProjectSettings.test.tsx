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
    render(<ProjectSettings {...defaultProps} onSecretsLoad={async () => ({})} />);
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
        onSecretsLoad={async () => ({})}
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

  it("loads existing secrets on render", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue({ API_KEY: "secret123" });
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
  });

  it("adds a new row when Add variable is clicked", async () => {
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));
    expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
  });

  it("removes a row when remove button is clicked", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue({ KEY_A: "a", KEY_B: "b" });
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-remove-0"));
    expect(screen.queryByTestId("secret-key-1")).not.toBeInTheDocument();
  });

  it("calls onSecretsSave with key-value object on save", async () => {
    const onSecretsSave = vi.fn();
    const onSecretsLoad = vi.fn().mockResolvedValue({});
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
      { MY_KEY: "my_value" },
    );
  });

  it("secret values use password input type", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue({ KEY: "secret" });
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
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
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
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
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
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
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
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByTestId("secret-value-STRIPE_KEY")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("secret-value-STRIPE_KEY"), {
      target: { value: "sk_live_x" },
    });
    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { STRIPE_KEY: "sk_live_x" },
    );
  });
});
