import { prepareUpstreamProxyRequest } from "./providers/proxy";
import { isGatewayWebuiRuntime } from "./runtimeEnv";

// Hub（Skills / MCP 商店）浏览类请求的出网适配层：
// - 桌面端：一律改经本地反代并声明 use-system-proxy，应用代理启用时经代理出网、
//   未启用时 Rust 侧直连、配置异常 502 fail fast（下载安装与 SkillsManager 的
//   ClawHub 调用在 Rust 侧走 services/system_proxy，与此处语义一致）。
// - Gateway WebUI：跑在浏览器里，gateway 无 /proxy 路由、桌面应用代理不可达，
//   保持浏览器直连。
// 签名有意窄于 typeof fetch：桌面分支需要重写请求地址，无法保真转发 Request
// 对象自带的 method/headers/body，收窄为 string | URL 让编译器直接拒绝该用法。
export async function hubFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (isGatewayWebuiRuntime()) {
    return fetch(input, init);
  }
  const prepared = await prepareUpstreamProxyRequest(
    typeof input === "string" ? input : input.toString(),
  );
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(prepared.headers)) {
    headers.set(name, value);
  }
  return fetch(prepared.url, { ...init, headers });
}
