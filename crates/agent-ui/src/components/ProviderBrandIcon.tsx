import {
  ClaudeIcon,
  DeepseekIcon,
  GeminiIcon,
  GrokIcon,
  OpenaiChatgptIcon,
} from "@liveagent/ui/components/IconSet";
import type { ProviderId } from "@liveagent/ui/lib/settings/types";
import { cn } from "@liveagent/ui/lib/shared/utils";

const KNOWN_PROVIDER_IDS: readonly ProviderId[] = [
  "codex",
  "claude_code",
  "gemini",
  "xai",
  "deepseek",
];

// Sidebar rows carry providerId as a wide string: legacy rows persist "",
// GUI optimistic rows may fall back to "pending", and web optimistic rows
// store a custom provider *instance* id. Only enum hits may reach the icon —
// anything else would render as the OpenAI fallback below.
export function isKnownProviderId(value: string | undefined): value is ProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value ?? "");
}

// Unmatched types (including "codex") fall through to the OpenAI icon; callers
// that need "unknown renders nothing" must guard with isKnownProviderId first.
export function ProviderBrandIcon({ type, className }: { type?: ProviderId; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "xai") return <GrokIcon className={cls} />;
  if (type === "deepseek") return <DeepseekIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
}
