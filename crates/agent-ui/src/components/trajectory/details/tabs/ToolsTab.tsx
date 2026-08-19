import { toolCatalogContent } from "../sectionData";
import { Empty, SectionFailure, TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

function prettyCatalog(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function ToolsTab(props: DetailTabProps) {
  if (props.sectionState.status === "loading" || props.sectionState.status === "failed") {
    return (
      <SectionFailure state={props.sectionState} onRetry={props.onRetrySections} t={props.t} />
    );
  }
  const content = toolCatalogContent(props.header, props.sectionById);
  if (content === undefined) return <Empty t={props.t} />;
  return <TextBlock value={prettyCatalog(content)} t={props.t} language="json" />;
}
