import type { ConversationReferenceInsertResult } from "@liveagent/ui/lib/chat/conversationReferenceDrag";
import type {
  CodeMentionReference,
  ConversationMentionReference,
  FileMentionKind,
  FileMentionReference,
} from "@liveagent/ui/lib/chat/mentionReferences";
import { MAX_CONVERSATION_MENTION_REFERENCES } from "@liveagent/ui/lib/chat/mentionReferences";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MentionFileEntry {
  path: string;
  kind: FileMentionKind;
}

export interface MentionListResponse {
  entries: MentionFileEntry[];
  truncated: boolean;
}

export type MentionSearchEntry = {
  entry: MentionFileEntry;
  searchPath: string;
};

export type MentionComposerSkill = {
  name: string;
  description: string;
  skillFile: string;
  baseDir: string;
};

export type MentionComposerSkillMention = MentionComposerSkill;

export type MentionComposerConversation = ConversationMentionReference & {
  messageCount?: number;
  /** Matching history excerpt returned by the server-side conversation search. */
  searchPreview?: string;
};

export type MentionComposerConversationMention = ConversationMentionReference;

/**
 * 一条可被 @ 提及的已安装应用（computer use 的操作目标）。宿主负责枚举与
 * 门控：只有当前工作区挂了 cua-driver 时才把列表传进来，WebUI 恒为空。
 */
export type MentionComposerApp = {
  name: string;
  /** macOS bundle id；其他平台可能缺失，此时以 path 兜底标识。 */
  bundleId?: string;
  path: string;
  /**
   * `data:image/png;base64,…` 应用图标，仅用于弹层行渲染；chip 与剪贴板
   * 序列化有意不携带（几 KB 的 data URL 进 DOM 属性会把复制载荷撑爆）。
   */
  iconDataUrl?: string;
};

/** chip / 草稿 / 剪贴板携带的应用身份——不含图标，见 iconDataUrl 注释。 */
export type MentionComposerAppMention = Omit<MentionComposerApp, "iconDataUrl">;

export type MentionComposerCommitMention = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  fileCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  stat: string;
  remoteName: string;
  remoteUrl: string;
  githubUrl?: string;
};

export type MentionComposerGitFileMention = {
  path: string;
  oldPath?: string;
  status: string;
  commitSha: string;
  shortSha: string;
  refName: string;
  remoteName: string;
  remoteUrl: string;
  githubUrl?: string;
};

export type MentionSuggestion =
  | { type: "file"; entry: MentionFileEntry }
  | { type: "skill"; skill: MentionComposerSkill }
  | { type: "app"; app: MentionComposerApp }
  | { type: "conversation"; conversation: MentionComposerConversation }
  | { type: "category"; category: "files" | "conversations" };

export type MentionMenuMode = "root" | "files" | "conversations";

export type ComposerContextMenuState = {
  x: number;
  y: number;
  selectedText: string;
  hasContent: boolean;
};

/** Where the @ or / trigger lives inside a text node */
export interface MentionContext {
  trigger: "file" | "skill";
  query: string;
  textNode: Text;
  triggerOffset: number; // char offset of the trigger inside textNode
}

export interface MentionComposerHandle {
  getText: () => string;
  getDraft: () => MentionComposerDraft;
  hasContent: () => boolean;
  setText: (text: string) => void;
  setDraft: (draft: MentionComposerDraft) => void;
  insertFileMention: (path: string, kind: "file" | "dir") => void;
  insertSkillMention: (skill: MentionComposerSkillMention) => void;
  insertCommitMention: (commit: MentionComposerCommitMention) => void;
  insertGitFileMention: (file: MentionComposerGitFileMention) => void;
  insertConversationMention: (
    conversation: MentionComposerConversationMention,
  ) => ConversationReferenceInsertResult;
  insertCodeMention: (reference: CodeMentionReference) => void;
  clear: () => void;
  focus: () => void;
  /**
   * Clear the composer and type `text` in with a typewriter animation.
   * User input is locked out while it runs; resolves once the full text
   * has landed in the editor (or the run was cancelled).
   */
  typeText: (text: string) => Promise<void>;
  beginTransientText: () => boolean;
  updateTransientText: (text: string) => void;
  commitTransientText: (text?: string) => void;
  cancelTransientText: (options?: { preserveLastText?: boolean }) => void;
}

export type MentionComposerLargePaste = {
  id: string;
  label: string;
  text: string;
  charCount: number;
  lineCount: number;
  preview: string;
};

export type MentionComposerDraftSegment =
  | { type: "text"; text: string }
  | { type: "fileMention"; reference: FileMentionReference }
  | { type: "largePaste"; paste: MentionComposerLargePaste }
  | { type: "skillMention"; skill: MentionComposerSkillMention }
  | { type: "appMention"; app: MentionComposerAppMention }
  | { type: "commitMention"; commit: MentionComposerCommitMention }
  | { type: "gitFileMention"; file: MentionComposerGitFileMention }
  | { type: "conversationMention"; conversation: MentionComposerConversationMention }
  | { type: "codeMention"; reference: CodeMentionReference };

export type MentionComposerDraft = {
  segments: MentionComposerDraftSegment[];
  text: string;
  textWithoutLargePastes: string;
  largePastes: MentionComposerLargePaste[];
  skillMentions: MentionComposerSkillMention[];
  appMentions: MentionComposerAppMention[];
  commitMentions: MentionComposerCommitMention[];
  gitFileMentions: MentionComposerGitFileMention[];
  /** Optional for backward compatibility with drafts persisted before conversation mentions. */
  conversationMentions?: MentionComposerConversationMention[];
  codeMentions: CodeMentionReference[];
  isEmpty: boolean;
};

export type ComposerClipboardSnapshot = {
  text: string;
  html: string;
  payload: string;
};

export interface MentionComposerProps {
  /** Called when user presses Enter (without Shift). */
  onSend: () => void;
  /** Called only when empty/non-empty state flips. */
  onEmptyChange?: (isEmpty: boolean) => void;
  onBusyChange?: (isBusy: boolean) => void;
  onPasteFiles?: (files: File[]) => void;
  /**
   * Returns prompts previously sent in this conversation, oldest → newest.
   * Enables shell-style ↑/↓ recall while the caret sits on the first/last
   * line of the editor. Read lazily when recall starts.
   */
  loadHistoryPrompts?: () => readonly string[];
  disabled?: boolean;
  placeholder?: string;
  workdir: string;
  enabledSkills?: MentionComposerSkill[];
  conversations?: MentionComposerConversation[];
  /** Searches the complete persisted history when the conversation query is non-empty. */
  searchConversations?: (query: string) => Promise<MentionComposerConversation[]>;
  /** Conversation references need the agent runtime's read-only history tool. */
  conversationMentionsEnabled?: boolean;
  /**
   * @ 弹层里的「应用」候选（computer use 目标）。由宿主门控：仅当会话挂着
   * cua-driver 时非空；缺省/空数组时 @ 行为与从前完全一致。
   */
  mentionApps?: MentionComposerApp[];
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const MAX_SUGGESTIONS = 30;
export const MAX_CONVERSATION_MENTIONS = MAX_CONVERSATION_MENTION_REFERENCES;
/** 应用分组的独立上限——应用排在弹层最前，条数过多会把文件结果推出视野。 */
export const MAX_APP_SUGGESTIONS = 3;
export const MENTION_INDEX_MAX_RESULTS = 5000;
export const MENTION_REFETCH_DEBOUNCE_MS = 150;
export const MENTION_TAG_ATTR = "data-mention-path";
export const MENTION_KIND_ATTR = "data-mention-kind";
export const SKILL_MENTION_NAME_ATTR = "data-skill-name";
export const SKILL_MENTION_FILE_ATTR = "data-skill-file";
export const SKILL_MENTION_BASE_DIR_ATTR = "data-skill-base-dir";
export const SKILL_MENTION_DESCRIPTION_ATTR = "data-skill-description";
export const APP_MENTION_NAME_ATTR = "data-app-name";
export const APP_MENTION_BUNDLE_ID_ATTR = "data-app-bundle-id";
export const APP_MENTION_PATH_ATTR = "data-app-path";
export const COMMIT_MENTION_SHA_ATTR = "data-commit-sha";
export const COMMIT_MENTION_SHORT_SHA_ATTR = "data-commit-short-sha";
export const COMMIT_MENTION_SUBJECT_ATTR = "data-commit-subject";
export const COMMIT_MENTION_BODY_ATTR = "data-commit-body";
export const COMMIT_MENTION_AUTHOR_NAME_ATTR = "data-commit-author-name";
export const COMMIT_MENTION_AUTHOR_EMAIL_ATTR = "data-commit-author-email";
export const COMMIT_MENTION_AUTHOR_DATE_ATTR = "data-commit-author-date";
export const COMMIT_MENTION_FILE_COUNT_ATTR = "data-commit-file-count";
export const COMMIT_MENTION_FILES_CHANGED_ATTR = "data-commit-files-changed";
export const COMMIT_MENTION_INSERTIONS_ATTR = "data-commit-insertions";
export const COMMIT_MENTION_DELETIONS_ATTR = "data-commit-deletions";
export const COMMIT_MENTION_STAT_ATTR = "data-commit-stat";
export const COMMIT_MENTION_REMOTE_NAME_ATTR = "data-commit-remote-name";
export const COMMIT_MENTION_REMOTE_URL_ATTR = "data-commit-remote-url";
export const COMMIT_MENTION_GITHUB_URL_ATTR = "data-commit-github-url";
export const GIT_FILE_MENTION_PATH_ATTR = "data-git-file-path";
export const GIT_FILE_MENTION_OLD_PATH_ATTR = "data-git-file-old-path";
export const GIT_FILE_MENTION_STATUS_ATTR = "data-git-file-status";
export const GIT_FILE_MENTION_COMMIT_SHA_ATTR = "data-git-file-commit-sha";
export const GIT_FILE_MENTION_SHORT_SHA_ATTR = "data-git-file-short-sha";
export const GIT_FILE_MENTION_REF_NAME_ATTR = "data-git-file-ref-name";
export const GIT_FILE_MENTION_REMOTE_NAME_ATTR = "data-git-file-remote-name";
export const GIT_FILE_MENTION_REMOTE_URL_ATTR = "data-git-file-remote-url";
export const GIT_FILE_MENTION_GITHUB_URL_ATTR = "data-git-file-github-url";
export const CONVERSATION_MENTION_ID_ATTR = "data-conversation-mention-id";
export const CONVERSATION_MENTION_TITLE_ATTR = "data-conversation-mention-title";
export const CONVERSATION_MENTION_CWD_ATTR = "data-conversation-mention-cwd";
export const CONVERSATION_MENTION_UPDATED_AT_ATTR = "data-conversation-mention-updated-at";
export const CODE_MENTION_PATH_ATTR = "data-code-mention-path";
export const CODE_MENTION_START_ATTR = "data-code-mention-start";
export const CODE_MENTION_END_ATTR = "data-code-mention-end";
export const LARGE_PASTE_TAG_ATTR = "data-large-paste-id";
export const COMPOSER_CLIPBOARD_MIME = "application/x-liveagent-composer-draft+json";
export const COMPOSER_CLIPBOARD_HTML_ATTR = "data-liveagent-composer-clipboard";
export const COMPOSER_CLIPBOARD_VERSION = 1;
export const LARGE_PASTE_CHAR_THRESHOLD = 8_000;
export const LARGE_PASTE_LINE_THRESHOLD = 200;
export const LARGE_PASTE_PREVIEW_CHARS = 160;
export const COMPOSER_CONTEXT_MENU_WIDTH = 184;
export const COMPOSER_CONTEXT_MENU_HEIGHT = 154;
export const COMPOSER_CONTEXT_MENU_MARGIN = 12;
export const CARET_ANCHOR_TEXT = "\u200B";
export const IME_ENTER_SUPPRESS_WINDOW_MS = 300;
export const IME_COMPOSITION_END_ENTER_TAIL_MS = 20;
// Must match the .composer-typewriter-char animation duration in index.css.
export const TYPEWRITER_CHAR_FADE_MS = 220;
export const GITHUB_ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

export const LARGE_PASTE_COUNT_FORMAT = new Intl.NumberFormat();

/** lucide app-window，与 chip 内其他图标同为 12×12 currentColor。 */
export const APP_MENTION_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></svg>';

export function formatLargePasteCount(value: number) {
  return LARGE_PASTE_COUNT_FORMAT.format(value);
}
