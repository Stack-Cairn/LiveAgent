const internalToken = process.env.LIVEAGENT_INTERNAL_TOKEN;
const backendPort = process.env.LIVEAGENT_BACKEND_PORT;

if (!internalToken || !backendPort) {
  console.error('Missing required environment variables: LIVEAGENT_INTERNAL_TOKEN or LIVEAGENT_BACKEND_PORT');
  process.exit(1);
}

export async function callBackend(
  command: string,
  args: unknown,
  signal?: AbortSignal
): Promise<unknown> {
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

    if (!response.ok) {
      throw new Error(`Backend call failed for command "${command}": ${response.status} ${text}`);
    }

    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith('Backend call failed')) {
      throw error;
    }
    if (error instanceof Error) {
      throw new Error(`Backend call failed for command "${command}": ${error.message}`);
    }
    throw error;
  }
}
