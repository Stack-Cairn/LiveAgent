import { JsonBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function RawTab({ record, t }: DetailTabProps) {
  return <JsonBlock value={record} t={t} />;
}
