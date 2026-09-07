import {
  EXTERNAL_TOOL_SOURCE_LABELS,
  ExternalToolSourceIcon,
} from "@liveagent/ui/components/resources/ExternalToolSourceIcon";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@liveagent/ui/components/ui/tabs";
import type { ExternalToolScan } from "@liveagent/ui/lib/skills/index";

const EXTERNAL_TOOL_OPTIONS = [
  { tool: "claude-code", label: EXTERNAL_TOOL_SOURCE_LABELS["claude-code"] },
  { tool: "codex", label: EXTERNAL_TOOL_SOURCE_LABELS.codex },
  { tool: "codebuddy", label: EXTERNAL_TOOL_SOURCE_LABELS.codebuddy },
  { tool: "agents", label: EXTERNAL_TOOL_SOURCE_LABELS.agents },
] as const;

const EXTERNAL_TOOL_IDS: ReadonlySet<string> = new Set(
  EXTERNAL_TOOL_OPTIONS.map((option) => option.tool),
);

export function SkillsImportSourceTabs(props: {
  scans: ExternalToolScan[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const orderedSources = [
    ...EXTERNAL_TOOL_OPTIONS.map((option) => ({
      ...option,
      scan: props.scans.find((scan) => scan.tool === option.tool),
    })),
    ...props.scans
      .filter((scan) => !EXTERNAL_TOOL_IDS.has(scan.tool))
      .map((scan) => ({ tool: scan.tool, label: scan.tool, scan })),
  ];

  return (
    <Tabs
      value={props.value}
      onValueChange={(value) => {
        if (props.scans.some((scan) => scan.tool === value)) props.onChange(String(value));
      }}
      className="min-w-0 flex-1"
    >
      <TabsList className="flex h-auto max-w-full flex-nowrap justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {orderedSources.map(({ tool, label, scan }) => (
          <TabsTrigger
            key={tool}
            value={tool}
            disabled={props.disabled || !scan}
            aria-label={`${label}: ${scan?.exists ? scan.skills.length : 0}`}
            className="group shrink-0 gap-1 rounded-md border border-transparent px-2 text-[11.5px] font-medium text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground data-[active]:bg-muted data-[active]:text-foreground data-[active]:shadow-none disabled:opacity-60"
          >
            <ExternalToolSourceIcon tool={tool} className="h-3.5 w-3.5" />
            <span>{label}</span>
            <Badge
              variant="muted"
              className="h-4 min-w-4 rounded-full px-1 text-[9.5px] font-semibold tabular-nums group-data-[active]:bg-foreground/[0.08] group-data-[active]:text-foreground"
            >
              {scan ? (scan.exists ? scan.skills.length : "—") : "…"}
            </Badge>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
