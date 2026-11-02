// 运行中命令输出（K-brain tool.status 快照）的展示整理（#975）。后端已把快照
// 限制在几 KB 的尾部，这里再按行数/字符数兜底，保证常驻 DOM 有界。
export const LIVE_SHELL_OUTPUT_MAX_LINES = 200;
export const LIVE_SHELL_OUTPUT_MAX_CHARS = 8000;

// CSI（颜色、光标移动、清行）与 OSC（终端标题、超链接）序列；进度条输出里常见。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配终端控制序列本身
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * 去掉终端控制序列，按回车（\r）只保留每行最后一次重绘（进度条），再截取尾部。
 */
export function formatLiveShellOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      const lastReturn = text.lastIndexOf("\r");
      return lastReturn >= 0 ? text.slice(lastReturn + 1) : text;
    });
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let text = lines.slice(-LIVE_SHELL_OUTPUT_MAX_LINES).join("\n");
  if (text.length > LIVE_SHELL_OUTPUT_MAX_CHARS) {
    text = text.slice(text.length - LIVE_SHELL_OUTPUT_MAX_CHARS);
    const firstBreak = text.indexOf("\n");
    if (firstBreak >= 0 && firstBreak < LIVE_SHELL_OUTPUT_MAX_CHARS / 2) {
      text = text.slice(firstBreak + 1);
    }
  }
  return text;
}
