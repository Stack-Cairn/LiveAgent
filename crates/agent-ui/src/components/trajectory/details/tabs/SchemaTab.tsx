import { toolCatalogContent, toolSchemaFromCatalog } from "../sectionData";
import { Empty, SectionFailure, TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function SchemaTab(props: DetailTabProps) {
  if (props.record.schemaDetail !== undefined) {
    return <TextBlock value={props.record.schemaDetail} t={props.t} language="json" />;
  }
  if (props.sectionState.status === "loading" || props.sectionState.status === "failed") {
    return (
      <SectionFailure state={props.sectionState} onRetry={props.onRetrySections} t={props.t} />
    );
  }
  const schema = toolSchemaFromCatalog(
    toolCatalogContent(props.header, props.sectionById),
    props.record.toolName,
  );
  return schema === undefined ? (
    <Empty t={props.t} />
  ) : (
    <TextBlock value={schema} t={props.t} language="json" />
  );
}
