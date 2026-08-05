export type StreamDebugLogger = {
  logRequest?: (payload: any) => void;
  logResponse?: (payload: any) => void;
  logResult?: (result: any) => void;
  logError?: (error: any) => void;
  flush?: () => Promise<void>;
  enabled?: boolean;
};

export function buildStreamRequestDebugPayload(req: any): any {
  return {};
}

export const StreamDebugLogger = {
  enabled: false,
};
