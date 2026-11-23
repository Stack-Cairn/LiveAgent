// Errors carry a translation key the login page renders in the user's
// language; other server text is shown as-is.
export const GATEWAY_AUTH_ERROR_KEYS = {
  required: "login.errorTokenRequired",
  unauthorized: "login.errorTokenInvalid",
  failed: "login.errorVerifyFailed",
} as const;

const AUTH_ERROR_KEY_VALUES: ReadonlySet<string> = new Set(Object.values(GATEWAY_AUTH_ERROR_KEYS));

export function isGatewayAuthErrorKey(message: string | null | undefined): boolean {
  return AUTH_ERROR_KEY_VALUES.has(message ?? "");
}

function readUnauthorizedErrorMessage(errorText: string) {
  return errorText === "unauthorized" ? GATEWAY_AUTH_ERROR_KEYS.unauthorized : errorText;
}

async function readFetchError(response: Response, fallback: string) {
  const raw = (await response.text()).trim();
  if (!raw) {
    return fallback;
  }

  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const errorText =
      typeof payload.error === "string"
        ? payload.error.trim()
        : typeof payload.message === "string"
          ? payload.message.trim()
          : "";
    return readUnauthorizedErrorMessage(errorText || raw);
  } catch {
    return readUnauthorizedErrorMessage(raw);
  }
}

export function normalizeGatewayAccessToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const match = trimmed.match(/^bearer\s+(.+)$/i);
  if (!match) {
    return trimmed;
  }

  return match[1]?.trim() ?? "";
}

export async function verifyGatewayAccessToken(input: string) {
  const token = normalizeGatewayAccessToken(input);
  if (!token) {
    throw new Error(GATEWAY_AUTH_ERROR_KEYS.required);
  }

  const response = await fetch(`${window.location.origin}/api/status`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await readFetchError(response, GATEWAY_AUTH_ERROR_KEYS.failed));
  }

  return token;
}
