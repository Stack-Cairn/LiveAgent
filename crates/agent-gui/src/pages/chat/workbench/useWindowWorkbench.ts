// The window-level workbench layout hook is shared with the WebUI; the
// implementation lives in @liveagent/ui so both hosts drive the same reducer.
export {
  ROOT_CONVERSATION_PANE_ID,
  type UseWindowWorkbenchParams,
  useWindowWorkbench,
  type WindowWorkbench,
  type WorkbenchOpenConversationInput,
} from "@liveagent/ui/lib/workbench/useWindowWorkbench";
