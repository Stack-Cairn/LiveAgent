/**
 * Intl formatter 缓存。
 *
 * 构造一个 `Intl.*Format` 会走 ICU 初始化（`udat_open` →
 * `icu::SimpleDateFormat`），是公认的昂贵操作。在渲染体或定时器回调里每次
 * `new` 一次，等价于每个 tick 做一次 ICU 初始化：实测长会话下这条路径把渲染
 * 进程 CPU 顶到 100%+，`sample` 抓到的热点栈正是
 * `timerFired → JSEventListener::handleEvent → constructIntlDateTimeFormat →
 * udat_open`。同一个 formatter 的生命周期应当是进程级的——locale 集合极小，
 * 选项形状在调用点都是字面量常量。
 *
 * 缓存键是 `${variant}|${locale}`，而不是把 options 序列化进去：调用方为每处
 * 调用点给一个稳定的 variant 名，这样键只是短字符串拼接；若用
 * `JSON.stringify(options)` 作键，每次调用都要付一次序列化成本，等于把省下来的
 * ICU 开销换成字符串开销——而那正是同一份 sample 里 `WTF::findCommon` 那类
 * 热点的由来。
 *
 * 用法：同一处调用点必须始终使用同一个 variant 名，并始终传同一套 options。
 * variant 与 options 不一致会让缓存返回错误的格式化结果，因此这里不做运行时
 * 校验——调用点相邻书写，评审时一眼可见。
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function cacheKey(variant: string, locale: string | undefined): string {
  return `${variant}|${locale ?? ""}`;
}

export function cachedNumberFormat(
  locale: string | undefined,
  variant: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = cacheKey(variant, locale);
  const cached = numberFormats.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, options);
  numberFormats.set(key, formatter);
  return formatter;
}

export function cachedDateTimeFormat(
  locale: string | undefined,
  variant: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = cacheKey(variant, locale);
  const cached = dateTimeFormats.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeFormats.set(key, formatter);
  return formatter;
}

export function cachedRelativeTimeFormat(
  locale: string | undefined,
  variant: string,
  options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = cacheKey(variant, locale);
  const cached = relativeTimeFormats.get(key);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, options);
  relativeTimeFormats.set(key, formatter);
  return formatter;
}

/** 测试用：清空缓存（省略参数则全清）。 */
export function clearIntlFormatterCaches(kind?: "number" | "dateTime" | "relativeTime"): void {
  if (kind === undefined || kind === "number") numberFormats.clear();
  if (kind === undefined || kind === "dateTime") dateTimeFormats.clear();
  if (kind === undefined || kind === "relativeTime") relativeTimeFormats.clear();
}
