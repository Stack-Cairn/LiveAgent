import { Empty, SourceBlocks } from "../shared";
import type { DetailTabProps } from "../types";

export function SourceTab(props: DetailTabProps) {
  const { record, t } = props;
  if (
    (record.sourceBlocks === undefined || record.sourceBlocks.length === 0) &&
    (record.outputBlocks === undefined || record.outputBlocks.length === 0)
  ) {
    return <Empty t={t} />;
  }
  return (
    <div className="space-y-4">
      {record.sourceBlocks !== undefined && (
        <SourceBlocks
          blocks={record.sourceBlocks}
          t={t}
          workdir={props.workdir}
          onOpenFileLink={props.onOpenFileLink}
        />
      )}
      {record.outputBlocks !== undefined && (
        <SourceBlocks
          blocks={record.outputBlocks}
          t={t}
          workdir={props.workdir}
          onOpenFileLink={props.onOpenFileLink}
        />
      )}
    </div>
  );
}
