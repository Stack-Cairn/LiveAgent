import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocale } from "../i18n";
import { Button } from "./ui/button";

type FallbackLabels = {
  title: string;
  description: string;
  reload: string;
  copy: string;
};

type ErrorBoundaryInnerProps = {
  children: ReactNode;
  labels: FallbackLabels;
};

type ErrorBoundaryInnerState = {
  error: Error | null;
  componentStack: string;
};

class ErrorBoundaryInner extends Component<ErrorBoundaryInnerProps, ErrorBoundaryInnerState> {
  state: ErrorBoundaryInnerState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryInnerState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AppErrorBoundary]", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <div className="text-base font-semibold text-foreground">{this.props.labels.title}</div>
        <div className="max-w-md text-sm text-muted-foreground">
          {this.props.labels.description}
        </div>
        <div className="max-h-40 max-w-xl overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/40 p-3 text-left font-mono text-[11px] text-muted-foreground">
          {error.message}
          {import.meta.env.DEV && this.state.componentStack
            ? `\n${this.state.componentStack}`
            : null}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>{this.props.labels.reload}</Button>
          <Button
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(
                `${error.stack ?? error.message}\n${this.state.componentStack}`,
              );
            }}
          >
            {this.props.labels.copy}
          </Button>
        </div>
      </div>
    );
  }
}

export function AppErrorBoundary(props: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <ErrorBoundaryInner
      labels={{
        title: t("app.errorBoundaryTitle"),
        description: t("app.errorBoundaryDesc"),
        reload: t("app.errorBoundaryReload"),
        copy: t("app.errorBoundaryCopy"),
      }}
    >
      {props.children}
    </ErrorBoundaryInner>
  );
}
