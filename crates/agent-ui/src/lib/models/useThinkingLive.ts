import { useSyncExternalStore } from "react";
import { getCatalogLiveVersion, subscribeCatalogLive } from "./catalogLive";
import { getThinkingLiveVersion, subscribeThinkingLive } from "./thinkingLive";

// thinkingLive.ts / catalogLive.ts 保持 react-free（node 测试直接加载）；此文件是
// 唯一的 react 胶水：消费方把版本号计入 useMemo 依赖，档位数据异步到达后档位
// 列表随之重算。档位先查生效目录（含运行期目录），再查 models.dev 补充，所以
// 两路数据任一到达都要让消费方重算：返回两个单调递增版本号之和。
function subscribeThinkingSources(listener: () => void): () => void {
  const unsubscribeThinking = subscribeThinkingLive(listener);
  const unsubscribeCatalog = subscribeCatalogLive(listener);
  return () => {
    unsubscribeThinking();
    unsubscribeCatalog();
  };
}

function getThinkingSourcesVersion(): number {
  return getThinkingLiveVersion() + getCatalogLiveVersion();
}

export function useThinkingLiveVersion(): number {
  return useSyncExternalStore(
    subscribeThinkingSources,
    getThinkingSourcesVersion,
    getThinkingSourcesVersion,
  );
}

/** 运行期模型目录版本：限额/模态/档位任一变化时递增。 */
export function useCatalogLiveVersion(): number {
  return useSyncExternalStore(subscribeCatalogLive, getCatalogLiveVersion, getCatalogLiveVersion);
}
