import { getGatewayOrigin } from "@/lib/gatewayOrigin";
import { nativeFetch as fetch } from "@/lib/nativeNet";

function readUnauthorizedErrorMessage(errorText: string) {
  return errorText === "unauthorized" ? "Access Token 错误，请检查后重试。" : errorText;
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
    throw new Error("请输入 Access Token。");
  }

  const response = await fetch(`${getGatewayOrigin()}/api/status`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await readFetchError(response, "Access Token 验证失败。"));
  }

  return token;
}
