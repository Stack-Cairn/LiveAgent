export type MemoryMeta = any;

export function memoryApplyBatch(_items: any[]): Promise<void> {
  return Promise.resolve();
}

export function memoryList(): Promise<any[]> {
  return Promise.resolve([]);
}

export function memoryRecentRejections(): Promise<any[]> {
  return Promise.resolve([]);
}

export function memoryTodayLocalDate(): string {
  return new Date().toISOString().split('T')[0];
}
