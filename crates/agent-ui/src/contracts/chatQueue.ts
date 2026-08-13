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
  items: ChatQueueItemSummary[];
};

export type ChatQueueItemDetail = ChatQueueItemSummary & {
  draftJson: string;
  uploadedFilesJson: string;
};
