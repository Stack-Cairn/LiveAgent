export type RetryAttemptRecord = {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
  /** 即将执行的退避时长（毫秒）；旧事件没有该字段。 */
  plannedDelayMs?: number;
  /** 产生这次重试的候选标签（"Provider · model"）；failover 下区分候选。 */
  providerLabel?: string;
};
