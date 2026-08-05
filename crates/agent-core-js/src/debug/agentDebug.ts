export type StreamDebugLogger = {
  logResult: (data: any) => void;
};

export function createStreamDebugLogger(config: any): StreamDebugLogger {
  return {
    logResult: () => {},
  };
}
