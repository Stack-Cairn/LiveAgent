import { ConversationPaneHost } from "../surfaces/ConversationPaneHost";
import {
  type ConversationPaneHostEnvironment,
  ConversationPaneHostEnvironmentProvider,
} from "../surfaces/ConversationPaneHostEnvironment";
import {
  assertConversationPaneHarnessSpecs,
  type ConversationPaneHarnessSpec,
} from "./conversationPaneHarnessModel";

export type { ConversationPaneHarnessSpec } from "./conversationPaneHarnessModel";
export { assertConversationPaneHarnessSpecs } from "./conversationPaneHarnessModel";

export type ConversationPaneHarnessProps = {
  environment: ConversationPaneHostEnvironment;
  panes: readonly [ConversationPaneHarnessSpec, ConversationPaneHarnessSpec];
};

export function ConversationPaneHarness(props: ConversationPaneHarnessProps) {
  const { environment, panes } = props;
  assertConversationPaneHarnessSpecs(panes);

  return (
    <ConversationPaneHostEnvironmentProvider value={environment}>
      <div
        data-conversation-pane-harness="two-pane"
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {panes.map((pane, index) => (
          <div
            key={pane.paneId}
            className={
              index === 0
                ? "relative flex min-h-0 min-w-0 flex-1 overflow-hidden border-r border-border/60"
                : "relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
            }
          >
            <ConversationPaneHost
              paneId={pane.paneId}
              conversationId={pane.conversationId}
              project={pane.project}
            />
          </div>
        ))}
      </div>
    </ConversationPaneHostEnvironmentProvider>
  );
}
