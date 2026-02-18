import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FeaturesPanel } from "./FeaturesPanel.js";
import type { FeatureInfo } from "../../server/types.js";

function makeFeature(overrides?: Partial<FeatureInfo>): FeatureInfo {
  return {
    id: "001-test-feature",
    number: 1,
    name: "Test Feature",
    status: "planned",
    planPath: "docs/001-test-feature/plan.md",
    ...overrides,
  };
}

describe("FeaturesPanel", () => {
  const defaultProps = () => ({
    features: [] as FeatureInfo[],
    onStartSession: vi.fn(),
    onRefresh: vi.fn(),
  });

  afterEach(cleanup);

  describe("empty state", () => {
    it("shows empty message when no features", () => {
      render(<FeaturesPanel {...defaultProps()} />);
      expect(screen.getByText("No features found")).toBeInTheDocument();
    });

    it("shows help text about creating feature docs", () => {
      render(<FeaturesPanel {...defaultProps()} />);
      expect(screen.getByText(/docs\/NNN-feature-name\/plan\.md/)).toBeInTheDocument();
    });

    it("shows refresh button in empty state", () => {
      const props = defaultProps();
      render(<FeaturesPanel {...props} />);
      fireEvent.click(screen.getByText("Refresh"));
      expect(props.onRefresh).toHaveBeenCalledOnce();
    });
  });

  describe("rendering features", () => {
    it("renders feature names", () => {
      const props = defaultProps();
      props.features = [
        makeFeature({ id: "001-auth", name: "Auth", number: 1 }),
        makeFeature({ id: "002-deploy", name: "Deploy", number: 2 }),
      ];
      render(<FeaturesPanel {...props} />);
      expect(screen.getByText("Auth")).toBeInTheDocument();
      expect(screen.getByText("Deploy")).toBeInTheDocument();
    });

    it("renders feature numbers", () => {
      const props = defaultProps();
      props.features = [
        makeFeature({ id: "001-auth", name: "Auth", number: 1 }),
      ];
      render(<FeaturesPanel {...props} />);
      expect(screen.getByText("001")).toBeInTheDocument();
    });

    it("renders status badges", () => {
      const props = defaultProps();
      props.features = [
        makeFeature({ id: "001-a", name: "A", number: 1, status: "planned" }),
        makeFeature({ id: "002-b", name: "B", number: 2, status: "in-progress" }),
        makeFeature({ id: "003-c", name: "C", number: 3, status: "done" }),
      ];
      render(<FeaturesPanel {...props} />);
      // Each status text appears as both a group label and a badge
      expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);
    });

    it("shows feature count in header", () => {
      const props = defaultProps();
      props.features = [
        makeFeature({ id: "001-a", name: "A", number: 1 }),
        makeFeature({ id: "002-b", name: "B", number: 2 }),
      ];
      render(<FeaturesPanel {...props} />);
      expect(screen.getByText("2 features")).toBeInTheDocument();
    });

    it("shows singular 'feature' for single feature", () => {
      const props = defaultProps();
      props.features = [makeFeature()];
      render(<FeaturesPanel {...props} />);
      expect(screen.getByText("1 feature")).toBeInTheDocument();
    });

    it("groups features by status", () => {
      const props = defaultProps();
      props.features = [
        makeFeature({ id: "001-a", name: "A", number: 1, status: "in-progress" }),
        makeFeature({ id: "002-b", name: "B", number: 2, status: "planned" }),
        makeFeature({ id: "003-c", name: "C", number: 3, status: "done" }),
      ];
      render(<FeaturesPanel {...props} />);
      // Each status appears as both group label and badge (at least 2 each)
      expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("interactions", () => {
    it("calls onStartSession when Start Session button is clicked", () => {
      const props = defaultProps();
      const feature = makeFeature({ id: "001-auth", name: "Auth", number: 1 });
      props.features = [feature];
      render(<FeaturesPanel {...props} />);
      fireEvent.click(screen.getByText("Start Session"));
      expect(props.onStartSession).toHaveBeenCalledWith(feature);
    });

    it("calls onRefresh when Reload is clicked", () => {
      const props = defaultProps();
      props.features = [makeFeature()];
      render(<FeaturesPanel {...props} />);
      fireEvent.click(screen.getByText("Reload"));
      expect(props.onRefresh).toHaveBeenCalledOnce();
    });
  });
});
