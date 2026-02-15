import { Component, type ReactNode, type ErrorInfo } from "react";

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
        <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-100">
          <div className="max-w-md text-center space-y-4 p-8">
            <div className="text-red-400 text-4xl">!</div>
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-gray-400">
              An unexpected error occurred while rendering the application.
            </p>
            {this.state.error && (
              <pre className="text-xs text-red-300 bg-gray-900 rounded p-3 overflow-x-auto text-left">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3 justify-center pt-2">
              <button
                onClick={this.handleReload}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
              >
                Reload Page
              </button>
              <button
                onClick={this.handleDismiss}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700 transition-colors"
              >
                Try to Recover
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
