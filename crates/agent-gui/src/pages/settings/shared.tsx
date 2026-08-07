export {
  ConfirmActionPopover,
  ConfirmDeletePopover,
} from "../../components/ui/confirm-action-popover";

export function PromptTag({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] leading-none tracking-[-0.01em] ${
        muted
          ? "border-border/60 bg-muted/40 text-muted-foreground"
          : "border-border/70 bg-muted/60 text-foreground/80"
      }`}
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
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={disabled ? undefined : onToggle}
      className={`settings-switch relative h-5 w-9 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
        checked
          ? "bg-emerald-500"
          : disabled
            ? "bg-muted-foreground/15"
            : "bg-muted-foreground/25 hover:bg-muted-foreground/35"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""} ${className ?? ""}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
