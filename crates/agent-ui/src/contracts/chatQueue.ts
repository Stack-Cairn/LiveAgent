export type ChatQueueItemSummary = {
  id: string;
  previewText: string;
  fileCount: number;
  createdAt: number;
  source: "gui" | "webui";
  editable: boolean;
};

export type ChatQueueSnapshot = {
  conversationId: string;
  revision: number;
  /** Omitted by legacy executors without backend-owned pause/resume. */
  paused?: boolean;
  items: ChatQueueItemSummary[];
};

export type ChatQueueItemDetail = ChatQueueItemSummary & {
  draftJson: string;
  uploadedFilesJson: string;
};
