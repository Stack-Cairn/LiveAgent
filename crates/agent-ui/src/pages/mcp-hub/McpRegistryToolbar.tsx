import { RefreshCw } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  MCP_REGISTRY_SOURCE_OPTIONS,
  type McpRegistrySource,
} from "@liveagent/ui/lib/mcpRegistry/index";
import { cn } from "@liveagent/ui/lib/shared/utils";

export function McpRegistryToolbar(props: {
  source: McpRegistrySource;
  loading: boolean;
  loadingMore: boolean;
  onSourceChange: (source: McpRegistrySource) => void;
  onRefresh: () => void;
}) {
  const { t } = useLocale();

  return (
    <div className="flex items-center justify-between gap-3">
      <Tabs
        value={props.source}
        onValueChange={(value) => {
          const nextSource = MCP_REGISTRY_SOURCE_OPTIONS.find(
            (option) => option.value === value,
          )?.value;
          if (nextSource) props.onSourceChange(nextSource);
        }}
        className="min-w-0 max-w-full"
      >
        <TabsList aria-label={t("mcpHub.tabStore")} variant="filter">
          {MCP_REGISTRY_SOURCE_OPTIONS.map((option) => (
            <TabsTrigger
              key={option.value}
              value={option.value}
              className="shrink-0 rounded-md border border-transparent px-2.5 text-11p5px font-medium text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground data-[active]:bg-muted data-[active]:text-foreground data-[active]:shadow-none"
            >
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Button
        size="sm"
        variant="outline"
        type="button"
        className="size-8 shrink-0 rounded-lg px-0 sm:w-auto sm:gap-1.5 sm:px-3"
        disabled={props.loading || props.loadingMore}
        onClick={props.onRefresh}
        title={t("mcpHub.storeRefresh")}
        aria-label={t("mcpHub.storeRefresh")}
      >
        <RefreshCw className={cn("size-3.5", props.loading && "animate-spin")} />
        <span className="hidden sm:inline">{t("mcpHub.storeRefresh")}</span>
      </Button>
    </div>
  );
}
