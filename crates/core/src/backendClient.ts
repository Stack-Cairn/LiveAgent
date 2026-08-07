const backendPort = process.env.LIVEAGENT_BACKEND_PORT;

if (!backendPort) {
  console.error('Missing required environment variable: LIVEAGENT_BACKEND_PORT');
  process.exit(1);
}

// 引擎凭据。backend spawn 本进程时经环境变量下发,每次 spawn 换一把。
// 这里不硬性要求存在:强制方在 backend,缺了的后果是每一次调用都 401 —— 够响亮。
// 而单元测试是直接 import 本模块跑的,它们没有 backend,不该被启动检查挡住。
const backendToken = process.env.LIVEAGENT_BACKEND_TOKEN;

export async function callBackend<T = unknown>(
  command: string,
  args?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const url = `http://127.0.0.1:${backendPort}/api/${command}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
    },
    // 与 tauri invoke 一致:不带参数的命令发空对象,后端按无字段结构体反序列化。
    body: JSON.stringify(args ?? {}),
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
