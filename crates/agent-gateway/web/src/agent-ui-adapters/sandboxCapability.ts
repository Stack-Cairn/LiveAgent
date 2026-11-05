import type { SandboxSetupOutcome } from "@liveagent/ui/lib/kbrain/sandboxSetup";

export type { SandboxSetupOutcome };

export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /** 是否支持断网变体(sandboxOffline)。 */
  network_control: boolean;
  read_masking?: boolean;
  path_protection?: boolean;
  reason?: string;
  /** 仅桌面端:可在本机运行 Windows 沙箱 setup。WebUI 永远不提供。 */
  setup_available?: true;
  setup_hint?: string;
};

/** WebUI:浏览器侧不读 K-brain health;null 表示能力未知,由 Gateway 提交前按 run_sandbox 裁决。 */
export function useSandboxCapability(): SandboxCapability | null {
  return null;
}

/**
 * WebUI:Windows 沙箱 setup 会在运行 K-brain 的机器上弹出 UAC,远程浏览器无法完成,
 * 所以从不提供(useSandboxCapability 为 null,入口也不会显示)。
 */
export async function setUpOfflineSandbox(): Promise<SandboxSetupOutcome> {
  return { status: "unsupported" };
}
