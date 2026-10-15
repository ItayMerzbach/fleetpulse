import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  name: string;
  children: ReactNode;
  /** Render-prop fallback; defaults to a compact inline error with retry. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Wraps every panel/widget independently: a bug in the chart widget must not
 * take down the map or route management a dispatcher is actively using.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.name}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="error-box" role="alert">
        <strong>{this.props.name} failed to render.</strong>
        <span className="muted"> {error.message}</span>
        <button className="btn btn-sm" onClick={this.reset}>
          Retry
        </button>
      </div>
    );
  }
}
