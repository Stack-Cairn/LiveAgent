import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { backendFetch } from "../../lib/backend/client";
import { PROMPT_RUN_RECONCILE_INTERVAL_MS } from "./promptRunProtocol";

const PROMPT_PENDING_EVENT = "automation:prompt-pending";

/**
 * 定时任务(Auto Prompt)的触发器。
 *
 * 执行本身在 core 引擎里(crates/core/src/automation/cronPromptRunner.ts):
 * 认领、跑模型、回报结论、租约超时全归那边。引擎自带对账定时器,所以
 * 定时任务**不再依赖界面开着**;这个组件只是把「刚有任务排进队列」立刻
 * 告诉引擎,省掉一个轮询周期的延迟。
 *
 * 兜底的 interval 只为一件事:壳事件漏投时不至于等到引擎自己的下一轮。
 */
export function CronPromptRunner() {
  useEffect(() => {
    let disposed = false;

    function poke() {
      if (disposed) return;
      void backendFetch("cron_prompt_poke", {}).catch((error) => {
        console.warn("Cron Auto Prompt poke failed", error);
      });
    }

    const unlistenPending = listen(PROMPT_PENDING_EVENT, poke);
    const reconcileTimer = window.setInterval(poke, PROMPT_RUN_RECONCILE_INTERVAL_MS);
    poke();

    return () => {
      disposed = true;
      window.clearInterval(reconcileTimer);
      void unlistenPending.then((unlisten) => unlisten());
    };
  }, []);

  return null;
}
