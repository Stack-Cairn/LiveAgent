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

/** 结构化问题的单个候选项。 */
export type ClarifyOption = {
  label: string;
  description?: string;
  /** 模型标注的推荐项（每题至多一个），UI 加推荐角标。 */
  recommended?: boolean;
};

/** 一道结构化澄清问题。UI 恒在选项底部合成「其他（自行输入）」行。 */
export type ClarifyQuestion = {
  id: string;
  /** 2-6 字主题短标签（轮次摘要用）；缺省按序号展示。 */
  header?: string;
  prompt: string;
  /** 可为空数组：纯开放问题，回答区只有自由输入框。 */
  options: ClarifyOption[];
  /** true 时选项为多选（复选），且「其他」输入可与选项并存。 */
  allowMultiple?: boolean;
};

/** 用户对一道问题的应答。selectedLabels 为空且无 customText 即「未回答」。 */
export type ClarifyAnswer = {
  questionId: string;
  prompt: string;
  /** 选中的选项 label（单选 0/1 个，多选任意个）。 */
  selectedLabels: string[];
  /** 「其他」自由输入文本（去首尾空白后非空才算作答）。 */
  customText?: string;
};

/** 一轮问答。answers === null 表示本轮问题还在等用户作答。 */
export type ClarifyRound = {
  questions: ClarifyQuestion[];
  answers: ClarifyAnswer[] | null;
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
