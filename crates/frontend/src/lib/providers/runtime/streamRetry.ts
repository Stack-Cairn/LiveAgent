// 重试执行器在 crates/core（引擎侧发起请求、发 retry 事件）。前端只渲染引擎
// 报上来的重试记录，故这里只保留展示用的记录类型。

export type RetryAttemptRecord = {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
};
