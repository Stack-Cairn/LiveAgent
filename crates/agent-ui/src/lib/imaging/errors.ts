import { IMAGE_WIRE_VERSION, type ImageError, type ImageErrorDetails } from "./types";

const messages: Record<string, string> = {
  IMAGE_VERIFICATION_STORAGE_UNAVAILABLE: "Verification record could not be saved or restored",
  IMAGE_INVALID_INPUT: "Invalid image input",
  IMAGE_UNSUPPORTED_OPERATION: "Image operation is unsupported",
  IMAGE_REVISION_CONFLICT: "Image configuration revision changed",
  IMAGE_IDEMPOTENCY_CONFLICT: "Idempotency key belongs to a different request",
  IMAGE_CONNECTION_IN_USE: "Image connection is in use",
  IMAGE_AUTH_REQUIRED: "Image authentication is required",
  IMAGE_RATE_LIMITED: "Image request limit reached",
  IMAGE_EVENT_GAP: "Image event history is no longer available",
  IMAGE_NOT_FOUND: "Image object not found",
  IMAGE_FORBIDDEN: "Image access denied",
  IMAGE_UNAVAILABLE: "Image module unavailable",
  IMAGE_NO_IMAGE_OUTPUT: "Provider returned no image output",
  IMAGE_RESULT_UNKNOWN: "Image execution result is unknown",
  IMAGE_METHOD_NOT_ALLOWED: "Image method is not allowed",
  IMAGE_TOO_LARGE: "Image upload is too large",
  IMAGE_PROTOCOL_ERROR: "Invalid image server response",
  IMAGE_NETWORK_ERROR: "Image connection failed",
  IMAGE_ABORTED: "Image operation cancelled",
  IMAGE_STREAM_ENDED: "Image event stream ended before completion",
  IMAGE_EXPORT_FAILED: "Image export failed",
};
/** Codes with a fixed client message; the UI localizes each by code. */
export const IMAGE_ERROR_CODES = Object.keys(messages);
export const IMAGE_ERROR_FALLBACK_MESSAGE = "Image operation failed";

/** Never attaches response bodies, request inputs, native URLs or an upstream cause. */
export class ImageClientError extends Error implements ImageError {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly details?: ImageErrorDetails;
  constructor(
    code: string,
    status = 0,
    retryable = false,
    requestId = "",
    details?: ImageErrorDetails,
  ) {
    const safeCode = /^IMAGE_[A-Z0-9_]{1,80}$/.test(code) ? code : "IMAGE_UNAVAILABLE";
    super(messages[safeCode] ?? IMAGE_ERROR_FALLBACK_MESSAGE);
    this.name = "ImageClientError";
    this.code = safeCode;
    this.status = status;
    this.retryable = retryable;
    this.requestId = safeLabel(requestId);
    this.details = details === undefined ? undefined : parseDetails(details);
  }
}

function safeLabel(value: string): string {
  return /^[A-Za-z0-9_.-]{0,128}$/.test(value) ? value : "";
}
export function protocolError(status = 0): ImageClientError {
  return new ImageClientError("IMAGE_PROTOCOL_ERROR", status);
}
export function abortError(): ImageClientError {
  return new ImageClientError("IMAGE_ABORTED");
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw protocolError();
  return value;
}
function parseDetails(value: unknown): ImageErrorDetails {
  if (!isRecord(value)) throw protocolError();
  const result: ImageErrorDetails = {};
  for (const key of ["parameterKey", "connectionId", "targetId"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") throw protocolError();
      result[key] = safeLabel(value[key]);
    }
  }
  for (const key of [
    "expectedRevision",
    "actualRevision",
    "firstAvailableSeq",
    "lastEventSeq",
  ] as const) {
    if (value[key] !== undefined) result[key] = safeInteger(value[key]);
  }
  return result;
}
export function parseImageError(value: unknown): ImageError {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    typeof value.requestId !== "string"
  )
    throw protocolError();
  const error = new ImageClientError(
    value.code,
    0,
    value.retryable,
    value.requestId,
    value.details === undefined ? undefined : parseDetails(value.details),
  );
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId: error.requestId,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export async function responseError(response: Response): Promise<ImageClientError> {
  const status = response.status;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    /* Plain HTTP errors also occur before the image router. */
  }
  // Gateways may return an unversioned {error: ...} before reaching the image router.
  // Preserve their HTTP authentication/availability status without retaining that body.
  if (isRecord(body) && "version" in body) {
    if (body.version !== IMAGE_WIRE_VERSION) return protocolError(status);
    try {
      const error = parseImageError(body.error);
      return new ImageClientError(
        error.code,
        status,
        error.retryable,
        error.requestId,
        error.details,
      );
    } catch {
      return protocolError(status);
    }
  }
  const codes: Record<number, string> = {
    401: "IMAGE_AUTH_REQUIRED",
    403: "IMAGE_FORBIDDEN",
    404: "IMAGE_NOT_FOUND",
    405: "IMAGE_METHOD_NOT_ALLOWED",
    409: "IMAGE_REVISION_CONFLICT",
    413: "IMAGE_TOO_LARGE",
    422: "IMAGE_INVALID_INPUT",
    429: "IMAGE_RATE_LIMITED",
    503: "IMAGE_UNAVAILABLE",
  };
  return new ImageClientError(
    codes[status] ?? "IMAGE_UNAVAILABLE",
    status,
    status === 429 || status >= 500,
  );
}
