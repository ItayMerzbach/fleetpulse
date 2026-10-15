import { Component, type ReactNode } from 'react';

/** Keeps one broken panel from taking down the whole dashboard. */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel error">
        {this.props.name} failed: {this.state.error.message}{' '}
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
