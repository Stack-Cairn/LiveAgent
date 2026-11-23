import type { ErrorResponse } from "@/lib/proto/gen/proto/v2/gateway_pb";

/**
 * Machine-readable reason of a failed K-brain request the gateway forwards in
 * its local error (a failed model discovery: errorCode invalid_api_key,
 * not_found, rate_limited, unreachable or upstream_error, plus the provider's
 * HTTP status and short message). The transport copies it onto the rejected
 * Error, where the provider editor reads it.
 */
export type GatewayErrorDetail = {
  errorCode?: string;
  upstreamStatus?: number;
  upstreamMessage?: string;
};

/** A request that failed in the gateway or its backend. */
export type GatewayErrorFrame = {
  kind: "error";
  requestId: string;
  agentId: string;
  message: string;
  detail?: GatewayErrorDetail;
};

export function localErrorFields(value: ErrorResponse): {
  message: string;
  detail?: GatewayErrorDetail;
} {
  const message = value.message || "Request failed";
  const errorCode = value.errorCode.trim();
  if (!errorCode) return { message };
  const upstreamMessage = value.upstreamMessage.trim();
  return {
    message,
    detail: {
      errorCode,
      ...(value.upstreamStatus > 0 ? { upstreamStatus: value.upstreamStatus } : {}),
      ...(upstreamMessage ? { upstreamMessage } : {}),
    },
  };
}
