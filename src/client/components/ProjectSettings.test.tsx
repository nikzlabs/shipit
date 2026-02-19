import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProjectSettings, type ProjectSettingsProps } from "./ProjectSettings.js";
import type { DeployTargetInfo } from "../../server/types.js";

afterEach(cleanup);

const fakeTarget: DeployTargetInfo = {
  id: "vercel",
  name: "Vercel",
  description: "Deploy to Vercel",
  configFields: [
    { key: "token", label: "API Token", required: true, sensitive: true, placeholder: "tok_xxx" },
  ],
  supportsPreview: true,
};

const fakeTarget2: DeployTargetInfo = {
  id: "cloudflare",
  name: "Cloudflare Pages",
  description: "Deploy to Cloudflare",
  configFields: [
    { key: "token", label: "CF Token", required: true, sensitive: true },
    { key: "accountId", label: "Account ID", required: true, sensitive: false },
  ],
  supportsPreview: false,
};

const defaultProps: ProjectSettingsProps = {
  deployTargets: [fakeTarget, fakeTarget2],
  deployConfigStatus: {},
  onDeployConfigure: vi.fn(),
  onDeployDeleteConfig: vi.fn(),
  onClose: vi.fn(),
};

describe("ProjectSettings", () => {
  it("renders dialog with correct role and aria-label", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Project Settings");
  });

  it("renders header title", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Project Settings")).toBeInTheDocument();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("project-settings-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Project Settings"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on close button (x) click", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ProjectSettings - Target list", () => {
  it("shows target list with all targets", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
  });

  it("shows Deploy Targets heading", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Deploy Targets")).toBeInTheDocument();
  });

  it("shows empty state when no targets available", () => {
    render(<ProjectSettings {...defaultProps} deployTargets={[]} />);
    expect(screen.getByText("No deployment targets available.")).toBeInTheDocument();
  });

  it("shows Configured badge for configured targets", () => {
    render(<ProjectSettings {...defaultProps} deployConfigStatus={{ vercel: { configured: true } }} />);
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("shows Configure link for unconfigured targets", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByTestId("deploy-target-configure-vercel")).toHaveTextContent("Configure");
  });

  it("shows Reconfigure link for configured targets", () => {
    render(<ProjectSettings {...defaultProps} deployConfigStatus={{ vercel: { configured: true } }} />);
    expect(screen.getByTestId("deploy-target-configure-vercel")).toHaveTextContent("Reconfigure");
  });

  it("shows Remove credentials for configured targets", () => {
    render(<ProjectSettings {...defaultProps} deployConfigStatus={{ vercel: { configured: true } }} />);
    expect(screen.getByTestId("deploy-target-remove-vercel")).toHaveTextContent("Remove credentials");
  });

  it("does not show Remove credentials for unconfigured targets", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.queryByTestId("deploy-target-remove-vercel")).not.toBeInTheDocument();
  });

  it("calls onDeployDeleteConfig when Remove credentials is clicked", () => {
    const onDeployDeleteConfig = vi.fn();
    render(
      <ProjectSettings
        {...defaultProps}
        deployConfigStatus={{ vercel: { configured: true } }}
        onDeployDeleteConfig={onDeployDeleteConfig}
      />,
    );
    fireEvent.click(screen.getByTestId("deploy-target-remove-vercel"));
    expect(onDeployDeleteConfig).toHaveBeenCalledWith("vercel");
  });
});

describe("ProjectSettings - Config form", () => {
  it("shows config form when Configure is clicked", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    expect(screen.getByText("Configure Vercel")).toBeInTheDocument();
    expect(screen.getByText("API Token")).toBeInTheDocument();
    expect(screen.getByTestId("deploy-config-save")).toHaveTextContent("Save Configuration");
  });

  it("shows back button on config form", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    fireEvent.click(screen.getByLabelText("Back to targets"));
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
  });

  it("calls onDeployConfigure when config form is submitted", () => {
    const onDeployConfigure = vi.fn();
    render(<ProjectSettings {...defaultProps} onDeployConfigure={onDeployConfigure} />);
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    fireEvent.change(screen.getByTestId("deploy-config-field-token"), {
      target: { value: "my-token" },
    });
    fireEvent.click(screen.getByTestId("deploy-config-save"));
    expect(onDeployConfigure).toHaveBeenCalledWith("vercel", { token: "my-token" }, undefined);
  });

  it("passes project name when provided", () => {
    const onDeployConfigure = vi.fn();
    render(<ProjectSettings {...defaultProps} onDeployConfigure={onDeployConfigure} />);
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    fireEvent.change(screen.getByTestId("deploy-config-field-token"), {
      target: { value: "my-token" },
    });
    fireEvent.change(screen.getByTestId("deploy-config-project-name"), {
      target: { value: "my-project" },
    });
    fireEvent.click(screen.getByTestId("deploy-config-save"));
    expect(onDeployConfigure).toHaveBeenCalledWith("vercel", { token: "my-token" }, "my-project");
  });

  it("pre-fills project name for configured targets", () => {
    render(
      <ProjectSettings
        {...defaultProps}
        deployConfigStatus={{ vercel: { configured: true, projectName: "existing-project" } }}
      />,
    );
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    expect(screen.getByTestId("deploy-config-project-name")).toHaveValue("existing-project");
  });

  it("shows multiple config fields for targets with multiple fields", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByTestId("deploy-target-configure-cloudflare"));
    expect(screen.getByText("CF Token")).toBeInTheDocument();
    expect(screen.getByText("Account ID")).toBeInTheDocument();
  });
});
