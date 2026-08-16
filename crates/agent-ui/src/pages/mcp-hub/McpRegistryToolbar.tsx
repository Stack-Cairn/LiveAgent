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
    <div className="hub-panel-enter flex items-center justify-between gap-3">
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
        <TabsList
          aria-label={t("mcpHub.tabStore")}
          className="flex h-auto max-w-full flex-nowrap justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {MCP_REGISTRY_SOURCE_OPTIONS.map((option) => (
            <TabsTrigger
              key={option.value}
              value={option.value}
              className="h-7 shrink-0 rounded-md border border-transparent px-2.5 text-[11.5px] font-medium text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground data-[active]:bg-muted data-[active]:text-foreground data-[active]:shadow-none"
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
        className="h-8 w-8 shrink-0 rounded-lg px-0 sm:w-auto sm:gap-1.5 sm:px-3"
        disabled={props.loading || props.loadingMore}
        onClick={props.onRefresh}
        title={t("mcpHub.storeRefresh")}
        aria-label={t("mcpHub.storeRefresh")}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", props.loading && "animate-spin")} />
        <span className="hidden sm:inline">{t("mcpHub.storeRefresh")}</span>
      </Button>
    </div>
  );
}
