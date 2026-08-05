/** 楼层导航条目：一条用户发送的消息。 */
export type FloorEntry = {
  /** 虚拟列表行 key（与行模型的用户行 key 一致），用于跳转定位。 */
  rowKey: string;
  /** 稳定消息 id（持久化于 SQLite，重启不变），用于收藏。 */
  messageId: string;
  /** 消息开头若干字符，空白折叠后截断。 */
  preview: string;
};

/**
 * 楼层来源行的最小结构：桌面端渲染时间线（RenderTimelineItem）与 WebUI 转写
 * 行（TranscriptRow）都满足此形状，本模块因此可在两端字节级镜像。
 */
export type FloorSourceItem = {
  kind: string;
  key: string;
  text?: string;
  messageRef?: { messageId: string };
};

const PREVIEW_MAX_CHARS = 24;

export function buildFloorPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "…";
  // 按码点截断（Array.from 迭代码点），避免把 emoji 等代理对从中间劈开。
  const chars = Array.from(collapsed);
  return chars.length > PREVIEW_MAX_CHARS
    ? `${chars.slice(0, PREVIEW_MAX_CHARS).join("")}…`
    : collapsed;
}

/**
 * 从渲染行列表派生楼层列表。只保留 kind === "user" 的条目——工具调用/返回
 * 折叠在 assistant 组内、系统提示词不在时间线上，因此天然只剩用户消息。
 */
export function buildFloorEntries(items: readonly FloorSourceItem[]): FloorEntry[] {
  const entries: FloorEntry[] = [];
  for (const item of items) {
    if (item.kind !== "user") continue;
    entries.push({
      rowKey: item.key,
      messageId: item.messageRef?.messageId ?? item.key,
      preview: buildFloorPreview(item.text ?? ""),
    });
  }
  return entries;
}

/**
 * 收起态短横线的均匀采样：楼层数超过上限时等距取 maxMarkers 个（含首尾），
 * mustKeep（收藏楼层）始终保留。取样按「均分索引」而不是固定步长，楼层数
 * 越过上限时标记数连续过渡（n→n+1 不会出现数量骤减）。
 *
 * 注意：当前楼层不参与 mustKeep——滚动中强插/移除会让整列标记抖动；调用方
 * 应改用 resolveNearestSampledRowKey 把高亮落在最近的已采样标记上。
 */
export function sampleFloorEntries(
  floors: FloorEntry[],
  maxMarkers: number,
  mustKeepRowKeys: ReadonlySet<string>,
): FloorEntry[] {
  if (maxMarkers <= 0) return [];
  if (floors.length <= maxMarkers) return floors;
  const picked = new Set<number>();
  const lastIndex = floors.length - 1;
  for (let i = 0; i < maxMarkers; i++) {
    picked.add(Math.round((i * lastIndex) / (maxMarkers - 1 || 1)));
  }
  return floors.filter((floor, index) => picked.has(index) || mustKeepRowKeys.has(floor.rowKey));
}

/**
 * 在采样后的标记里找到与当前楼层最近的一个（按原始楼层序距离），让高亮
 * 始终有落点且不改变采样集合本身。
 */
export function resolveNearestSampledRowKey(
  floors: FloorEntry[],
  sampled: FloorEntry[],
  activeRowKey: string | null,
): string | null {
  if (!activeRowKey || sampled.length === 0) return null;
  if (sampled.some((floor) => floor.rowKey === activeRowKey)) return activeRowKey;
  const activeIndex = floors.findIndex((floor) => floor.rowKey === activeRowKey);
  if (activeIndex === -1) return null;
  let nearest: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const marker of sampled) {
    const markerIndex = floors.findIndex((floor) => floor.rowKey === marker.rowKey);
    if (markerIndex === -1) continue;
    const distance = Math.abs(markerIndex - activeIndex);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = marker.rowKey;
    }
  }
  return nearest;
}
