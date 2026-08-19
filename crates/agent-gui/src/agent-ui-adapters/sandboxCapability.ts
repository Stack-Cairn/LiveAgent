import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /**
   * 是否支持断网变体(sandboxOffline)。macOS/Linux 在 supported 时为 true;
   * Windows 取决于运行时探测(能否派生 AppContainer SID)。
   */
  network_control: boolean;
  reason?: string;
};

let cachedCapability: SandboxCapability | null = null;

/** 桌面端:探测本机 OS 沙箱可用性(macOS Seatbelt / Linux bwrap / Windows 受限令牌写围栏)。 */
export function useSandboxCapability(): SandboxCapability | null {
  const [capability, setCapability] = useState<SandboxCapability | null>(cachedCapability);

  useEffect(() => {
    if (cachedCapability) return;
    let disposed = false;
    invoke<SandboxCapability>("system_sandbox_capability")
      .then((result) => {
        cachedCapability = result;
        if (!disposed) setCapability(result);
      })
      .catch((error) => {
        console.warn("system_sandbox_capability failed", error);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return capability;
}
