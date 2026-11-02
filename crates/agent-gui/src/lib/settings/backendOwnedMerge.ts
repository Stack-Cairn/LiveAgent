import type { AppSettings } from "./index";
import type { PersistSettingsResult } from "./storage";

type BackendOwnedFields = Pick<PersistSettingsResult, "customProviders" | "ssh" | "stt">;

/** 保存后端权威字段：这些字段以 K-brain 返回的文档为准，合并回内存设置。 */
const BACKEND_OWNED_KEYS = ["customProviders", "ssh", "stt"] as const;

/**
 * 把一次保存返回的后端权威字段合并回内存设置；没有任何实际变化时返回 undefined。
 *
 * K-brain 每次 PATCH 都会重新构造 customProviders：选一次模型、改一次思考档位，
 * 内容没变但引用全新。直接写回会让依赖 customProviders 的 memo/effect 全部失效重跑
 * （模型目录重拉、对话区重渲染）。这里逐字段按内容比较，内容没变的沿用原引用，
 * 全部没变就返回 undefined，调用方据此跳过 setSettingsState。
 */
export function mergeBackendOwnedSettings(
  current: AppSettings,
  result: BackendOwnedFields,
  normalize: (settings: AppSettings) => AppSettings,
): AppSettings | undefined {
  const incoming: Partial<AppSettings> = {};
  for (const key of BACKEND_OWNED_KEYS) {
    const value = result[key];
    if (value === undefined) continue;
    // 与当前内存值逐字段相同：不进入补丁，避免换掉引用。
    if (JSON.stringify(value) === JSON.stringify(current[key])) continue;
    Object.assign(incoming, { [key]: value });
  }
  if (Object.keys(incoming).length === 0) return undefined;

  const merged = normalize({ ...current, ...incoming });
  let changed = false;
  for (const key of BACKEND_OWNED_KEYS) {
    // normalize 可能把未变化的字段规范化成新对象（补齐默认值、调整字段顺序）；
    // 规范化后仍与当前内容一致的，继续沿用原引用。
    if (JSON.stringify(merged[key]) === JSON.stringify(current[key])) {
      Object.assign(merged, { [key]: current[key] });
    } else {
      changed = true;
    }
  }
  return changed ? merged : undefined;
}
