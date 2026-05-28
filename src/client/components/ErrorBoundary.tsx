import { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "./ui/button.js";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary — catches unhandled render errors in the component
 * tree and displays a recovery UI instead of a blank screen.
 *
 * Must be a class component because React only supports error boundaries
 * via componentDidCatch / getDerivedStateFromError on class components.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-[100dvh] bg-(--color-bg-primary) text-(--color-text-primary)">
          <div className="max-w-md text-center space-y-4 p-8">
            <div className="text-(--color-error) text-4xl">!</div>
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-(--color-text-secondary)">
              An unexpected error occurred while rendering the application.
            </p>
            {this.state.error && (
              <pre className="text-xs text-(--color-error) bg-(--color-bg-secondary) rounded p-3 overflow-x-auto text-left">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3 justify-center pt-2">
              <Button
                onClick={this.handleReload}
                size="lg"
                className="rounded-lg"
              >
                Reload Page
              </Button>
              <Button
                variant="secondary"
                onClick={this.handleDismiss}
                size="lg"
                className="rounded-lg"
              >
                Try to Recover
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
