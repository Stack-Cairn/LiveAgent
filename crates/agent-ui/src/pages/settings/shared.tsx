import { CheckCircle2 } from "@liveagent/ui/components/IconSet";
import type { ReactNode } from "react";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/shared/utils";

export {
  ConfirmActionPopover,
  ConfirmDeletePopover,
} from "../../components/ui/confirm-action-popover";

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="px-1 text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="overflow-hidden rounded-2xl border border-border/75 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.02)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow(props: { title: string; description?: string; control: ReactNode }) {
  const { title, description, control } = props;

  return (
    <div className="relative flex min-h-[72px] flex-col gap-3 px-5 py-4 after:pointer-events-none after:absolute after:bottom-0 after:left-5 after:right-5 after:h-px after:bg-border/60 after:content-[''] last:after:hidden sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1 pr-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex w-full items-center sm:w-auto sm:shrink-0 sm:justify-end">{control}</div>
    </div>
  );
}

export function SettingsChoiceRow(props: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  const { icon, title, description, selected, onClick } = props;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="group relative flex w-full items-center gap-3 px-5 py-4 text-left transition-colors after:pointer-events-none after:absolute after:bottom-0 after:left-5 after:right-5 after:h-px after:bg-border/60 after:content-[''] last:after:hidden hover:bg-muted/20"
    >
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center transition-colors",
          selected
            ? "text-foreground/70"
            : "text-muted-foreground/45 group-hover:text-foreground/60",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center">
        {selected ? <CheckCircle2 className="h-4.5 w-4.5 text-foreground/80" /> : null}
      </span>
    </button>
  );
}

export function PromptTag({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] leading-none",
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
  onToggle: () => void;
}) {
  const { checked, title, disabled = false, className, onToggle } = props;

  return (
    <Switch
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={title}
      onCheckedChange={onToggle}
      className={className}
    />
  );
}
