import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";

/** 可澄清文本 = 草稿中存在非空白纯文本段。提及/附件 token 与大段粘贴不算：
 * 澄清的输入是用户写的提示词文本，只有 chip/附件时按钮应禁用而非点击空转。
 * 只在事件处理器里调用（读 DOM），渲染路径零调用。 */
export function draftHasClarifiableText(composer: MentionComposerHandle | null): boolean {
  return (
    composer
      ?.getDraft()
      .segments.some((segment) => segment.type === "text" && segment.text.trim().length > 0) ??
    false
  );
}

export function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
