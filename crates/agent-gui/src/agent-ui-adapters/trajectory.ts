/**
 * 轨迹视图的桌面端宿主：把共享实现接到真实的 Tauri invoke 上。
 */

import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { createInvokeTrajectoryHost } from "@liveagent/ui/lib/trajectory/host";
import { invoke } from "../shims/tauriCore";

/**
 * 构造桌面端宿主。
 *
 * @param openFileLink - 打开工作区文件的回调；缺省则详情面板不提供跳转。
 * @returns 轨迹视图宿主。
 */
export function createTauriTrajectoryHost(
  openFileLink?: (link: ChatFileLink) => void,
): TrajectoryHost {
  return createInvokeTrajectoryHost(invoke, {
    ...(openFileLink === undefined ? {} : { openFileLink }),
  });
}
