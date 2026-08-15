import { getGatewayOrigin } from "@/lib/gatewayOrigin";

// agent-mobile 是 Tauri 外壳：window.location.origin 是应用内部源（tauri://localhost），
// 相对路径 /icon-simple.png 会被解析到内部源导致裂图。这里改从已配置的 Gateway
// 源加载品牌图标（网关静态托管该文件，无需鉴权）。
export function getAssistantAvatarUrl() {
  return `${getGatewayOrigin()}/icon-simple.png`;
}
