// Off-main-thread fuzzy search for the palette's `@` file scope. The worker
// keeps the latest path list per workspace so each keystroke only posts the
// query, not the whole index.
import {
  type QuickOpenWorkerRequest,
  type QuickOpenWorkerResponse,
  runQuickOpenWorkerRequest,
} from "./fileQuickOpenProtocol";

const indexes = new Map<string, readonly string[]>();

self.onmessage = (event: MessageEvent<QuickOpenWorkerRequest>) => {
  const response: QuickOpenWorkerResponse | null = runQuickOpenWorkerRequest(indexes, event.data);
  if (response) self.postMessage(response);
};
