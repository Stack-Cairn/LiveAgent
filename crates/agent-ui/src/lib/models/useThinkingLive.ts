import { useSyncExternalStore } from "react";
import { getThinkingLiveVersion, subscribeThinkingLive } from "./thinkingLive";

// thinkingLive.ts 保持 react-free（node 测试直接加载）；此文件是唯一的 react
// 胶水：消费方把版本号计入 useMemo 依赖，补充数据异步到达后档位列表随之重算。
export function useThinkingLiveVersion(): number {
  return useSyncExternalStore(
    subscribeThinkingLive,
    getThinkingLiveVersion,
    getThinkingLiveVersion,
  );
}
