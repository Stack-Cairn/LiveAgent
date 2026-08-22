/**
 * 轨迹事件错误文本的密钥洗涤。
 *
 * 供应商报错可能回显完整请求 URL（Gemini 的 key 走 query 参数）或鉴权头
 * （Bearer token）。轨迹账本会落盘并跨端下发，任何进入 err 字段的文本都
 * 必须先过这一层。只做模式级替换，不改动正常报错文本。
 */

/** 取值形似密钥的 query 参数名（含 URL 编码变体场景由参数名匹配兜底）。 */
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:key|api[-_]?key|apikey|token|access[-_]?token|secret)=)[^&\s"']+/gi;

/** Authorization: Bearer <token> 回显。 */
const BEARER_TOKEN_PATTERN = /(bearer\s+)[a-z0-9._~+/-]{8,}=*/gi;

/** 常见密钥前缀（OpenAI/Anthropic sk-、Google AIza）。 */
const KNOWN_KEY_SHAPE_PATTERN = /\b(?:sk|AIza)[A-Za-z0-9_-]{16,}\b/g;

export function scrubSecretsFromErrorText(text: string): string {
  return text
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1[redacted]")
    .replace(BEARER_TOKEN_PATTERN, "$1[redacted]")
    .replace(KNOWN_KEY_SHAPE_PATTERN, "[redacted]");
}
