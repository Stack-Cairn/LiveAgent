// crates/agent-ui/src/components/chat/clarify/clarifyTypes.ts
/** 澄清小对话的消息。与 pi-ai Context 的 messages 同构，但独立于会话运行时。 */
export type ClarifyMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** 轻量工作区信息：只喂路径/分支，不含文件内容（见设计文档「上下文感知」）。 */
export type ClarifyContext = {
  workdir: string;
  gitBranch?: string;
};

/**
 * 执行一轮澄清补全。messages 含 system；返回完整回复文本（已由宿主拼装）。
 * onTextDelta 用于面板流式上屏；signal 由状态机贯穿取消。
 */
export type RunClarifyTurn = (
  messages: ClarifyMessage[],
  signal: AbortSignal,
  onTextDelta?: (delta: string) => void,
) => Promise<string>;
