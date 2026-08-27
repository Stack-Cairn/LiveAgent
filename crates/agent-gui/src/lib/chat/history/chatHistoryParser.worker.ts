type ParseRequest = {
  requestId: number;
  segments: Array<{
    payload: unknown;
    summaryJson?: string | null;
    messagesJson: string;
  }>;
};

type ParseResponse = {
  requestId: number;
  segments?: Array<{
    payload: unknown;
    summary: unknown;
    messages: unknown;
  }>;
  error?: string;
};

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { requestId, segments } = event.data;
  try {
    const parsed = segments.map((segment) => ({
      payload: segment.payload,
      summary: segment.summaryJson ? JSON.parse(segment.summaryJson) : undefined,
      messages: JSON.parse(segment.messagesJson),
    }));
    self.postMessage({ requestId, segments: parsed } satisfies ParseResponse);
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ParseResponse);
  }
};

export {};
