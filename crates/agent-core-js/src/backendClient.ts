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

  try {
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
    const parsed = JSON.parse(text);

    if (!response.ok) {
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        throw parsed.error;
      }
      throw new Error(`Backend call failed for command "${command}": ${response.status}`);
    }

    return parsed.ok;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    throw error;
  }
}
