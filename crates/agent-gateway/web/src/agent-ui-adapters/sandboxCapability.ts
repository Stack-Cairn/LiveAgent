export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /** 是否支持断网变体(sandboxOffline);由桌面端运行时探测得出。 */
  network_control: boolean;
  reason?: string;
};

/** WebUI:沙箱在桌面端执行,浏览器侧无从探测;null 表示能力未知(由桌面端裁决)。 */
export function useSandboxCapability(): SandboxCapability | null {
  return null;
}
