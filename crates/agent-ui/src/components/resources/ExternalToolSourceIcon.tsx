import {
  Bot,
  ClaudeIcon,
  FileText,
  Folder,
  OpenaiChatgptIcon,
  SkillIcon,
} from "@liveagent/ui/components/IconSet";

export const EXTERNAL_TOOL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  codebuddy: "CodeBuddy",
  agents: "Agent Skills",
};

const EXTERNAL_TOOL_SOURCE_ICONS: Readonly<Record<string, typeof Folder>> = {
  "claude-code": ClaudeIcon,
  "claude-desktop": ClaudeIcon,
  codex: OpenaiChatgptIcon,
  codebuddy: Bot,
  agents: SkillIcon,
  "local-file": FileText,
};

export function ExternalToolSourceIcon(props: { tool: string; className?: string }) {
  const SourceIcon = EXTERNAL_TOOL_SOURCE_ICONS[props.tool] ?? Folder;
  return <SourceIcon className={props.className} />;
}
