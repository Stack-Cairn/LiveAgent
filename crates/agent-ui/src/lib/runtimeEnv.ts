/**
 * Gateway WebUI 运行时判定的单一真源：web 端 main.tsx 在渲染前把
 * GATEWAY_WEBUI_MARKER 写入 <html data-liveagent-webui>；桌面端永不写入。
 * 需要区分两种运行时的镜像代码一律从这里引用，勿再复制字面量。
 */
export const GATEWAY_WEBUI_MARKER = "gateway";

export function isGatewayWebuiRuntime() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.liveagentWebui === GATEWAY_WEBUI_MARKER
  );
}
