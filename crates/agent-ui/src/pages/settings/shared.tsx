import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import type { ComponentProps, ReactNode } from "react";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/shared/utils";

export {
  ConfirmActionPopover,
  ConfirmDeletePopover,
} from "../../components/ui/confirm-action-popover";

export function SettingsGroup({
  title,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & { title: string; children: ReactNode }) {
  return (
    <SettingsSection {...props} title={title}>
      <SettingsCard>{children}</SettingsCard>
    </SettingsSection>
  );
}

export { SettingsRow };

export function PromptTag({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center",
        "whitespace-nowrap rounded-full border px-2 py-0.5 text-xs leading-none",
        muted
          ? "border-border/60 bg-muted/40 text-muted-foreground"
          : "border-border/70 bg-muted/60 text-foreground/80",
      )}
    >
      {label}
    </span>
  );
}

export function AgentActivationSwitch(props: {
  checked: boolean;
  title: string;
  disabled?: boolean;
  className?: string;
  /** Stable hook for end-to-end tests. */
  testId?: string;
  onToggle: () => void;
}) {
  const { checked, title, disabled = false, className, testId, onToggle } = props;

  return (
    <Switch
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={title}
      onCheckedChange={onToggle}
      className={className}
      data-testid={testId}
    />
  );
}
