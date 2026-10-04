import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Last line of defense: a render error anywhere below shows a recovery screen
 * instead of a blank page. Reloading also releases the camera and the socket.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div role="alert" className="min-h-screen bg-gray-900 flex items-center justify-center p-6 text-white">
        <div className="text-center space-y-4 max-w-sm">
          <h1 className="text-2xl font-bold text-yellow-400">Something went wrong</h1>
          <p className="text-gray-300">Chizzy hit an unexpected error. Reload the page to start again.</p>
          <button type="button" onClick={() => window.location.reload()} className="retro-button">
            Reload
          </button>
        </div>
      </div>
    );
  }
}
