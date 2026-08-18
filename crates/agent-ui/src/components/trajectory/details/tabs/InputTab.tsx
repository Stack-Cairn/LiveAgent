import { TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function InputTab({ record, t }: DetailTabProps) {
  return <TextBlock value={record.inputDetail} t={t} />;
}
