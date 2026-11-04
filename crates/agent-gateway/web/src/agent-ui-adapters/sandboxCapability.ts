export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /** 是否支持断网变体(sandboxOffline)。 */
  network_control: boolean;
  read_masking?: boolean;
  reason?: string;
};

/** WebUI:浏览器侧不读 K-brain health;null 表示能力未知,由 Gateway 提交前按 run_sandbox 裁决。 */
export function useSandboxCapability(): SandboxCapability | null {
  return null;
}
