export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  reason?: string;
};

/** WebUI:沙箱在桌面端执行,浏览器的 OS 不代表执行端平台;null = 未知,显示通用文案。 */
export function inferSandboxPlatform(): "macos" | "linux" | "windows" | null {
  return null;
}

/** WebUI:沙箱在桌面端执行,浏览器侧无从探测;null 表示能力未知(由桌面端裁决)。 */
export function useSandboxCapability(): SandboxCapability | null {
  return null;
}
