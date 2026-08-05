export const POWER_ACTIVITY = {};

export function withPowerActivity<T>(name: string, fn: () => T): T {
  return fn();
}
