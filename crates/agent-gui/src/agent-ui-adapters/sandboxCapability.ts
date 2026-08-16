import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { inferRuntimePlatform } from "../lib/runtimePlatform";

export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  reason?: string;
};

/** 桌面端:本机平台即沙箱执行平台,可在探测返回前先按平台渲染文案/禁用开关。 */
export function inferSandboxPlatform(): "macos" | "linux" | "windows" | null {
  return inferRuntimePlatform();
}

let cachedCapability: SandboxCapability | null = null;

/** 桌面端:探测本机 OS 沙箱可用性(macOS Seatbelt / Linux bwrap / Windows 未实现)。 */
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
