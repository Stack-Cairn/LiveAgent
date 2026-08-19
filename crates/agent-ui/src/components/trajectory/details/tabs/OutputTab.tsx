import { TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function OutputTab({ record, t }: DetailTabProps) {
  return <TextBlock value={record.outputDetail} t={t} />;
}
