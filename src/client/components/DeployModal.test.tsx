import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { DeployModal, type DeployModalProps } from "./DeployModal.js";
import type { DeployTargetInfo } from "../../server/types.js";

afterEach(cleanup);

const fakeTarget: DeployTargetInfo = {
  id: "vercel",
  name: "Vercel",
  description: "Deploy to Vercel",
  configFields: [
    { key: "token", label: "Token", required: true, sensitive: true, placeholder: "tok_xxx" },
  ],
  supportsPreview: true,
};

const fakeTarget2: DeployTargetInfo = {
  id: "cloudflare",
  name: "Cloudflare Pages",
  description: "Deploy to Cloudflare",
  configFields: [
    { key: "token", label: "API Token", required: true, sensitive: true },
    { key: "accountId", label: "Account ID", required: true, sensitive: false },
  ],
  supportsPreview: true,
};

const defaultProps: DeployModalProps = {
  targets: [fakeTarget, fakeTarget2],
  configStatus: {},
  deployStatus: null,
  lastDeployUrl: null,
  lastDeployError: null,
  deployHistory: [],
  onDeploy: vi.fn(),
  onCancel: vi.fn(),
  onGetHistory: vi.fn(),
  onSendErrorToChat: vi.fn(),
  onClose: vi.fn(),
};

describe("DeployModal", () => {
  it("shows not-configured message when no targets are configured", () => {
    render(<DeployModal {...defaultProps} />);
    expect(screen.getByText(/no deploy targets configured/i)).toBeInTheDocument();
    expect(screen.getByText(/Project Settings/)).toBeInTheDocument();
  });

  it("shows not-configured message when targets exist but none are configured", () => {
    render(<DeployModal {...defaultProps} targets={[fakeTarget]} configStatus={{}} />);
    expect(screen.getByText(/no deploy targets configured/i)).toBeInTheDocument();
  });

  it("auto-selects single configured target and shows ready view", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
      />,
    );
    expect(screen.getByText("Deploy to Production")).toBeInTheDocument();
  });

  it("shows target picker when multiple configured targets exist", () => {
    render(
      <DeployModal
        {...defaultProps}
        configStatus={{
          vercel: { configured: true },
          cloudflare: { configured: true },
        }}
      />,
    );
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
  });

  it("selects target from picker and shows ready view", () => {
    render(
      <DeployModal
        {...defaultProps}
        configStatus={{
          vercel: { configured: true },
          cloudflare: { configured: true },
        }}
      />,
    );
    fireEvent.click(screen.getByText("Vercel"));
    expect(screen.getByText("Deploy to Production")).toBeInTheDocument();
  });

  it("allows switching between production and preview", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
      />,
    );
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("Deploy to Preview")).toBeInTheDocument();
  });

  it("calls onDeploy when deploy button is clicked", () => {
    const onDeploy = vi.fn();
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        onDeploy={onDeploy}
      />,
    );
    fireEvent.click(screen.getByText("Deploy to Production"));
    expect(onDeploy).toHaveBeenCalledWith("vercel", "production");
  });

  it("shows Switch target link when multiple targets are configured", () => {
    render(
      <DeployModal
        {...defaultProps}
        configStatus={{
          vercel: { configured: true },
          cloudflare: { configured: true },
        }}
      />,
    );
    fireEvent.click(screen.getByText("Vercel"));
    expect(screen.getByText("Switch target")).toBeInTheDocument();
  });

  it("does not show Switch target link with single configured target", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
      />,
    );
    expect(screen.queryByText("Switch target")).not.toBeInTheDocument();
  });

  it("shows deploying state with cancel button", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployStatus="deploying"
      />,
    );
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    const heading = screen.getByRole("heading");
    expect(heading.textContent).toBe("Deploying...");
  });

  it("shows building state", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployStatus="building"
      />,
    );
    expect(screen.getByText("Building project...")).toBeInTheDocument();
  });

  it("calls onCancel during deployment", () => {
    const onCancel = vi.fn();
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployStatus="deploying"
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows success state with URL", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployStatus="complete"
        lastDeployUrl="https://my-app.vercel.app"
      />,
    );
    expect(screen.getByText("Deployment successful!")).toBeInTheDocument();
    expect(screen.getByText("https://my-app.vercel.app")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("shows error state with error message", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployStatus="error"
        lastDeployError="Build failed: missing dependency"
      />,
    );
    expect(screen.getByText("Deploy Failed")).toBeInTheDocument();
    expect(screen.getByText("Build failed: missing dependency")).toBeInTheDocument();
  });

  it("calls onSendErrorToChat when Send to Claude is clicked", () => {
    const onSendErrorToChat = vi.fn();
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployStatus="error"
        lastDeployError="Build failed"
        onSendErrorToChat={onSendErrorToChat}
      />,
    );
    fireEvent.click(screen.getByText("Send to Claude"));
    expect(onSendErrorToChat).toHaveBeenCalledWith("Build failed");
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        onClose={onClose}
      />,
    );
    const backdrop = screen.getByRole("dialog");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows deploy history in ready view", () => {
    render(
      <DeployModal
        {...defaultProps}
        targets={[fakeTarget]}
        configStatus={{ vercel: { configured: true } }}
        deployHistory={[
          {
            id: "d1",
            targetId: "vercel",
            environment: "production",
            url: "https://old-deploy.vercel.app",
            timestamp: "2025-01-01T00:00:00Z",
            durationMs: 5000,
            status: "success",
          },
        ]}
      />,
    );
    expect(screen.getByText("Recent Deployments")).toBeInTheDocument();
    expect(screen.getByText("https://old-deploy.vercel.app")).toBeInTheDocument();
  });

  it("shows Configure button in not-configured view when onOpenDeploySettings is provided", () => {
    const onOpenDeploySettings = vi.fn();
    const onClose = vi.fn();
    render(
      <DeployModal
        {...defaultProps}
        onClose={onClose}
        onOpenDeploySettings={onOpenDeploySettings}
      />,
    );
    const btn = screen.getByTestId("deploy-open-deploy-settings");
    expect(btn).toHaveTextContent("Configure");
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalled();
    expect(onOpenDeploySettings).toHaveBeenCalled();
  });

  it("does not show Configure button when onOpenDeploySettings is not provided", () => {
    render(<DeployModal {...defaultProps} />);
    expect(screen.queryByTestId("deploy-open-deploy-settings")).not.toBeInTheDocument();
  });
});
