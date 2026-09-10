import {
  EXTERNAL_TOOL_SOURCE_LABELS,
  ExternalToolSourceIcon,
} from "@liveagent/ui/components/resources/ExternalToolSourceIcon";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ExternalMcpToolScan } from "@liveagent/ui/lib/skills/index";

export const LOCAL_FILE_TOOL = "local-file";

function fileScanLabel(scan: ExternalMcpToolScan, fallback: string) {
  const basename = scan.configPath.split(/[\\/]/).pop();
  return basename || fallback;
}

export function McpImportSourcePicker(props: {
  scans: ExternalMcpToolScan[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLocale();

  return (
    <Tabs
      value={props.value}
      onValueChange={(value) => {
        if (props.scans.some((scan) => scan.tool === value)) props.onChange(value);
      }}
      className="max-w-full shrink-0"
    >
      <TabsList aria-label={t("mcpHub.tabImport")} variant="filter">
        {props.scans.map((scan) => {
          const isLocalFile = scan.tool === LOCAL_FILE_TOOL;
          const toolLabel = isLocalFile
            ? fileScanLabel(scan, t("mcpHub.importFileTab"))
            : (EXTERNAL_TOOL_SOURCE_LABELS[scan.tool] ?? scan.tool);
          return (
            <TabsTrigger
              key={scan.tool}
              value={scan.tool}
              title={isLocalFile ? scan.configPath : undefined}
              className="group shrink-0 gap-1.5 rounded-md border border-transparent px-2.5 text-11p5px font-medium text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground data-[active]:bg-muted data-[active]:text-foreground data-[active]:shadow-none"
            >
              <ExternalToolSourceIcon tool={scan.tool} className="size-3.5" />
              <span className="max-w-10rem truncate">{toolLabel}</span>
              <Badge variant="muted" size="filter-count">
                {scan.exists ? scan.servers.length : "—"}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
