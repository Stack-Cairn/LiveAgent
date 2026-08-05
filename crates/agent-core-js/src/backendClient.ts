const internalToken = process.env.LIVEAGENT_INTERNAL_TOKEN;
const backendPort = process.env.LIVEAGENT_BACKEND_PORT;

if (!internalToken || !backendPort) {
  console.error('Missing required environment variables: LIVEAGENT_INTERNAL_TOKEN or LIVEAGENT_BACKEND_PORT');
  process.exit(1);
}

export async function callBackend<T = unknown>(
  command: string,
  args: unknown,
  signal?: AbortSignal
): Promise<T> {
  const url = `http://127.0.0.1:${backendPort}/api/${command}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${internalToken}`,
    },
    body: JSON.stringify(args),
    signal,
  });

  const text = await response.text();

  // 解析响应，处理空 body
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error(`Backend call failed for "${command}": HTTP ${response.status} - invalid JSON response`);
  }

  if (!response.ok) {
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const errorValue = (parsed as any).error;
      if (typeof errorValue === 'string') {
        throw new Error(errorValue);
      }
      throw errorValue;
    }
    throw new Error(`Backend call failed for "${command}": HTTP ${response.status}`);
  }

  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed)) {
    throw new Error(`Backend call failed for "${command}": HTTP ${response.status} - missing ok field in response`);
  }

  return (parsed as { ok: T }).ok;
}
