import { AGENT_TOOL_NAME } from "./types";

export const DEFAULT_SUBAGENT_MAX_PARALLEL_RUNS = 8;
export const DEFAULT_AGENT_TOOL_MAX_PARALLEL_CALLS = DEFAULT_SUBAGENT_MAX_PARALLEL_RUNS;
export const DEFAULT_BASH_MAX_PARALLEL_EXECUTIONS = 4;

export type SubagentSchedulerLimits = {
  maxParallelSubagents?: number;
  maxParallelAgentToolCalls?: number;
  maxParallelBash?: number;
};

type SemaphoreWaiter = {
  resolve: (release: () => void) => void;
  cancelled: boolean;
  cleanup: () => void;
};

function normalizeLimit(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function createCancelledError() {
  return new Error("Cancelled");
}

class Semaphore {
  private active = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(createCancelledError());
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        cancelled: false,
        cleanup: () => undefined,
      };
      if (signal) {
        const onAbort = () => {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          waiter.cleanup();
          reject(createCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(waiter);
    });
  }

  private createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter || waiter.cancelled) continue;
      waiter.cleanup();
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

export class SubagentScheduler {
  readonly maxParallelSubagents: number;
  readonly maxParallelAgentToolCalls: number;
  readonly maxParallelBash: number;

  private readonly subagentRuns: Semaphore;
  private readonly bashExecutions: Semaphore;

  constructor(limits: SubagentSchedulerLimits = {}) {
    this.maxParallelSubagents = normalizeLimit(
      limits.maxParallelSubagents,
      DEFAULT_SUBAGENT_MAX_PARALLEL_RUNS,
    );
    this.maxParallelAgentToolCalls = normalizeLimit(
      limits.maxParallelAgentToolCalls,
      DEFAULT_AGENT_TOOL_MAX_PARALLEL_CALLS,
    );
    this.maxParallelBash = normalizeLimit(
      limits.maxParallelBash,
      DEFAULT_BASH_MAX_PARALLEL_EXECUTIONS,
    );
    this.subagentRuns = new Semaphore(this.maxParallelSubagents);
    this.bashExecutions = new Semaphore(this.maxParallelBash);
  }

  getParallelToolLimit(toolName: string) {
    if (toolName === AGENT_TOOL_NAME) return this.maxParallelAgentToolCalls;
    if (toolName === "Bash") return this.maxParallelBash;
    return 2;
  }

  runSubagent<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.subagentRuns.run(task, signal);
  }

  runBash<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.bashExecutions.run(task, signal);
  }
}

export function createSubagentScheduler(limits?: SubagentSchedulerLimits) {
  return new SubagentScheduler(limits);
}
