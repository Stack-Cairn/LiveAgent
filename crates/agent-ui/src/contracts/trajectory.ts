/**
 * 轨迹视图对宿主的能力要求。
 *
 * 共享 UI 只认这个契约：GUI 用 Tauri invoke 实现，WebUI 用 Gateway 请求实现。
 * 刻意保持窄小——轨迹是只读诊断视图，不需要任何写能力。
 */

import type { ChatFileLink } from "../lib/chat/chatFileLinks";
import type { TrajectorySection, TrajectorySubagentRun } from "../lib/trajectory/types";

export type TrajectoryEventsPayload = {
  /** 事件的扁平 JSON 数组文本。 */
  eventsJson: string;
  /** 是否有分段因损坏或触顶而缺失，UI 据此提示轨迹不完整。 */
  truncated: boolean;
};

export type TrajectoryEventsWindowPayload = TrajectoryEventsPayload & {
  /** 本窗口最早的 segment；作为继续向前分页的游标。 */
  oldestSegmentIndex: number;
  returnedSegmentCount: number;
  totalSegmentCount: number;
  hasMoreBefore: boolean;
};

export type TrajectoryHost = {
  /**
   * 从尾部按 segment 读取一页已落盘事件；传游标时继续向前分页。
   *
   * WebUI 在断线重连后以最新窗口与桌面端对账，实时事件仍由账本层幂等合并。
   */
  loadWindow: (
    conversationId: string,
    beforeSegmentIndex?: number,
  ) => Promise<TrajectoryEventsWindowPayload>;
  /**
   * 按需取 prompt 分段全文。
   *
   * 分段动辄几十 KB，不进实时事件流；只有用户展开 SYSTEM 行详情时才拉。
   */
  loadSections: (
    conversationId: string,
    sectionIds: readonly string[],
  ) => Promise<readonly TrajectorySection[]>;
  /** 按事件引用的 runId 批量取子代理运行；不支持时省略。 */
  loadSubagentRuns?: (
    conversationId: string,
    runIds: readonly string[],
  ) => Promise<readonly TrajectorySubagentRun[]>;
  /** 宿主的权威读取链路恢复或失效时通知视图重新对账。 */
  subscribeRefresh?: (listener: () => void) => () => void;
  /** 在宿主里打开一个工作区文件；不支持时省略。 */
  openFileLink?: (link: ChatFileLink) => void;
};
