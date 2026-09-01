// crates/agent-ui/src/components/chat/clarify/clarifyPanelScroll.ts
//
// 澄清面板问答列表的钉底跟随：流式增长时把 scrollTop 写到末端；读者
// 上翻阅读历史则停跟，回到末端附近再接上。阈值覆盖 DPR 舍入（scrollTop
// 常比物理 clamp 短 1–3px）。

export const CLARIFY_FOLLOW_THRESHOLD_PX = 32;

export type ClarifyScrollBox = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
};

export function isClarifyListFollowing(
  box: ClarifyScrollBox,
  thresholdPx = CLARIFY_FOLLOW_THRESHOLD_PX,
): boolean {
  return box.scrollHeight - box.clientHeight - box.scrollTop <= thresholdPx;
}

export function pinClarifyListIfFollowing(box: ClarifyScrollBox | null, following: boolean): void {
  if (!box || !following) return;
  box.scrollTop = box.scrollHeight;
}
