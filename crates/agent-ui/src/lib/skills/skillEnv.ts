import type { SkillEnvRequirement, SkillSummary } from "./index";

/**
 * 技能环境变量的用户配置与状态归并。
 *
 * 后端探测(SkillSummary.envRequirements)只作**建议**——扫描脚本判断依赖
 * 不够准确,不能当权威。启用门禁只认两类明确来源:metadata.env 声明的必填
 * 项,以及用户手动标记/采纳的变量。满足判定:用户填写的值优先,其次系统
 * 环境变量现场探测;明确必需项两者皆无时技能进入「待配置」,前端禁止启用、
 * 运行时拦截读取。每个技能的详情抽屉恒显配置入口,与探测结果无关。
 */

/** 单个技能环境变量的用户配置。 */
export type SkillEnvVarConfig = {
  /** 用户填写的值;空串等同未填写。 */
  value?: string;
  /**
   * 同步/存储脱敏后的"值已配置"标记:值本体只存在桌面端,WebUI 与
   * 浏览器缓存里的副本靠它保留已配置状态(对齐 provider apiKeyConfigured)。
   */
  configured?: boolean;
  /**
   * 对探测结论的覆盖:
   * - "required":弱信号升级为必需,或手动添加的变量;
   * - "ignored":误报豁免,不再参与门禁。
   */
  override?: "required" | "ignored";
};

/** 技能名 -> 变量名 -> 配置。只保存有内容的条目。 */
export type SkillEnvSettingsMap = Record<string, Record<string, SkillEnvVarConfig>>;

const SKILL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isValidSkillEnvVarName(name: string) {
  return SKILL_ENV_NAME_PATTERN.test(name);
}

function normalizeSkillEnvVarConfig(input: unknown): SkillEnvVarConfig | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const config: SkillEnvVarConfig = {};
  if (typeof obj.value === "string" && obj.value.trim()) {
    config.value = obj.value;
  }
  if (obj.configured === true) {
    config.configured = true;
  }
  if (obj.override === "required" || obj.override === "ignored") {
    config.override = obj.override;
  }
  return config.value !== undefined ||
    config.configured !== undefined ||
    config.override !== undefined
    ? config
    : null;
}

export function normalizeSkillEnvSettings(input: unknown): SkillEnvSettingsMap {
  if (!input || typeof input !== "object") return {};
  const out: SkillEnvSettingsMap = {};
  for (const [skillName, rawVars] of Object.entries(input as Record<string, unknown>)) {
    if (!skillName.trim() || !rawVars || typeof rawVars !== "object") continue;
    const vars: Record<string, SkillEnvVarConfig> = {};
    for (const [varName, rawConfig] of Object.entries(rawVars as Record<string, unknown>)) {
      if (!isValidSkillEnvVarName(varName)) continue;
      const config = normalizeSkillEnvVarConfig(rawConfig);
      if (config) vars[varName] = config;
    }
    if (Object.keys(vars).length > 0) {
      out[skillName] = vars;
    }
  }
  return out;
}

/** 归并后的单变量状态。 */
export type ResolvedSkillEnvRequirement = {
  name: string;
  /** 探测/声明置信度;"user" 表示用户手动添加。 */
  confidence: "declared" | "strong" | "weak" | "user";
  /** 应用覆盖后的最终必需性(参与启用门禁)。 */
  effectiveRequired: boolean;
  /** 满足来源:user=用户填写值,system=系统环境变量,missing=未满足。 */
  state: "user" | "system" | "missing";
  /** 被用户标记为误报豁免。 */
  ignored: boolean;
  provider: string | null;
  description: string | null;
  url: string | null;
  sources: string[];
};

export type SkillEnvStatus = {
  requirements: ResolvedSkillEnvRequirement[];
  /** 未满足的必需变量名。 */
  missingRequired: string[];
  /** 必需项全部满足(无必需项时为 true)。启用门禁与运行时拦截都以此为准。 */
  satisfied: boolean;
};

const EMPTY_SKILL_ENV_STATUS: SkillEnvStatus = {
  requirements: [],
  missingRequired: [],
  satisfied: true,
};

/**
 * 合并探测结果与用户配置,得到技能的环境变量最终状态。
 *
 * `probeOverrides` 用于携带 `env_status` 动作的现场探测结果(手动添加的变量
 * 不在后端列表探测范围内,详情页按需补测后传入)。
 */
export function resolveSkillEnvStatus(
  skill: Pick<SkillSummary, "name" | "envRequirements">,
  envSettings: SkillEnvSettingsMap | undefined,
  probeOverrides?: Record<string, boolean>,
): SkillEnvStatus {
  const requirements = skill.envRequirements ?? [];
  const config = envSettings?.[skill.name] ?? {};
  if (requirements.length === 0 && Object.keys(config).length === 0) {
    return EMPTY_SKILL_ENV_STATUS;
  }

  const resolved: ResolvedSkillEnvRequirement[] = [];
  const detectedNames = new Set<string>();

  const resolveState = (
    varConfig: SkillEnvVarConfig | undefined,
    systemValuePresent: boolean,
  ): ResolvedSkillEnvRequirement["state"] => {
    // configured=true 表示值已存在桌面端(WebUI 侧的脱敏副本没有值本体)。
    if (
      (typeof varConfig?.value === "string" && varConfig.value.trim()) ||
      varConfig?.configured === true
    ) {
      return "user";
    }
    if (systemValuePresent) return "system";
    return "missing";
  };

  for (const requirement of requirements) {
    detectedNames.add(requirement.name);
    const varConfig = config[requirement.name];
    const ignored = varConfig?.override === "ignored";
    // 门禁只认明确来源:声明必填 + 用户标记必需。探测(strong/weak)仅建议。
    const effectiveRequired = ignored
      ? false
      : varConfig?.override === "required"
        ? true
        : requirement.confidence === "declared" && requirement.required;
    const systemValuePresent = probeOverrides?.[requirement.name] ?? requirement.systemValuePresent;
    resolved.push({
      name: requirement.name,
      confidence: requirement.confidence,
      effectiveRequired,
      state: resolveState(varConfig, systemValuePresent),
      ignored,
      provider: requirement.provider ?? null,
      description: requirement.description ?? null,
      url: requirement.url ?? null,
      sources: requirement.sources,
    });
  }

  // 用户手动添加的变量(配置里有、探测里没有)。标记忽略的不展示。
  for (const [name, varConfig] of Object.entries(config)) {
    if (detectedNames.has(name) || varConfig.override === "ignored") continue;
    resolved.push({
      name,
      confidence: "user",
      effectiveRequired: varConfig.override === "required",
      state: resolveState(varConfig, probeOverrides?.[name] ?? false),
      ignored: false,
      provider: null,
      description: null,
      url: null,
      sources: [],
    });
  }

  const missingRequired = resolved
    .filter((entry) => entry.effectiveRequired && entry.state === "missing")
    .map((entry) => entry.name);

  return {
    requirements: resolved,
    missingRequired,
    satisfied: missingRequired.length === 0,
  };
}

/** 技能是否满足启用门禁(必需环境变量全部有值)。 */
export function isSkillEnvSatisfied(
  skill: Pick<SkillSummary, "name" | "envRequirements">,
  envSettings: SkillEnvSettingsMap | undefined,
) {
  return resolveSkillEnvStatus(skill, envSettings).satisfied;
}

/**
 * 收集应注入 shell 子进程的环境变量(仅用户填写的值;系统环境变量子进程
 * 本来就继承,不重复传递)。调用方负责只传入本会话生效的技能。
 * 同名冲突按技能名字典序处理,后者覆盖,保证结果确定。
 */
export function collectSkillEnvInjection(
  skills: ReadonlyArray<Pick<SkillSummary, "name">>,
  envSettings: SkillEnvSettingsMap | undefined,
): Record<string, string> {
  if (!envSettings) return {};
  const out: Record<string, string> = {};
  const names = skills.map((skill) => skill.name).sort((a, b) => a.localeCompare(b));
  for (const skillName of names) {
    const vars = envSettings[skillName];
    if (!vars) continue;
    for (const [varName, config] of Object.entries(vars)) {
      if (!isValidSkillEnvVarName(varName)) continue;
      if (typeof config.value === "string" && config.value.trim()) {
        out[varName] = config.value;
      }
    }
  }
  return out;
}

/** envRequirements 的稳定摘要,用于技能发现签名(变化触发 UI 刷新)。 */
export function skillEnvRequirementsSignature(
  requirements: SkillEnvRequirement[] | undefined,
): string {
  if (!requirements || requirements.length === 0) return "";
  return requirements
    .map(
      (entry) =>
        `${entry.name}:${entry.required ? "1" : "0"}:${entry.confidence}:${
          entry.systemValuePresent ? "1" : "0"
        }`,
    )
    .join(",");
}

/**
 * 解析手动添加输入:每行一个 `NAME` 或 `NAME=值`(容忍 `export ` 前缀、
 * `#` 注释行、成对引号包裹的值),返回合法条目,按出现顺序去重。
 * 支持一次粘贴多行(.env 风格)批量添加。
 */
export function parseSkillEnvAddEntries(input: string): Array<{ name: string; value?: string }> {
  const out: Array<{ name: string; value?: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/i, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = (eq >= 0 ? line.slice(0, eq) : line).trim();
    if (!isValidSkillEnvVarName(name) || seen.has(name)) continue;
    let value = eq >= 0 ? line.slice(eq + 1).trim() : "";
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    seen.add(name);
    out.push(value ? { name, value } : { name });
  }
  return out;
}
