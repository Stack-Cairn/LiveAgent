import type { ChatFileLink } from "../../../lib/chat/chatFileLinks";
import type {
  LedgerHeader,
  TrajectoryRecord,
  TrajectorySection,
} from "../../../lib/trajectory/types";

export type DetailTabId =
  | "systemPrompt"
  | "tools"
  | "overview"
  | "rendered"
  | "raw"
  | "source"
  | "input"
  | "output"
  | "schema"
  | "options"
  | "usage"
  | "timing"
  | "diff";

export type Translate = (key: string) => string;

export type SectionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; sections: readonly TrajectorySection[] }
  | { status: "failed" };

export type DetailTabProps = {
  record: TrajectoryRecord;
  header: LedgerHeader | undefined;
  previousHeader: LedgerHeader | undefined;
  sectionState: SectionState;
  sectionById: ReadonlyMap<string, TrajectorySection>;
  onRetrySections: () => void;
  locale: string;
  t: Translate;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
};
